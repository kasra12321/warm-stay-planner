/**
 * Pool Heat — Raspberry Pi bridge server
 *
 * Runs on a Raspberry Pi at a residential address. Pentair's RemoteLogin
 * dispatcher (screenlogicserver.pentair.com:500) silently rejects requests
 * from datacenter IPs, so the Lovable cloud backend cannot talk to it
 * directly. This server proxies those calls so they originate from the Pi's
 * residential IP.
 *
 * Auth: Bearer token in `Authorization: Bearer <PI_AUTH_TOKEN>` header,
 * matching the SCREENLOGIC_PI_AUTH_TOKEN secret stored in the cloud project.
 *
 * Endpoints:
 *   GET  /healthz                  → { ok: true, uptime, cached_systems }
 *   POST /api/pool/status          → { success, status: { pool_temp, pool_set_point, pool_heater, ... } }
 *   POST /api/pool/heater          → { success, actual_temp, verified }
 *
 * Body (status + heater):
 *   { systemName: "Pentair: 12-AB-CD", password: "1234", temp?: 82 }
 */

const express = require("express");
const { RemoteLogin, UnitConnection } = require("node-screenlogic");

const PORT = parseInt(process.env.PORT || "8787", 10);
const AUTH_TOKEN = process.env.PI_AUTH_TOKEN;
const CACHE_TTL_MS = 5 * 60 * 1000;
const VERIFY_DELAY_MS = 1500;

if (!AUTH_TOKEN) {
  console.error("FATAL: PI_AUTH_TOKEN env var is required");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "32kb" }));

// ─── System name normalization ───────────────────────────────────────────
// Pentair's dispatcher requires "Pentair: XX-XX-XX" (uppercase hex). Accept
// loose input from upstream callers and coerce; return null if invalid.
function normalizeSystemName(input) {
  if (!input) return null;
  let s = String(input).trim();
  s = s.replace(/^pentair\s*:\s*/i, "");
  s = s.replace(/O/gi, "0"); // O → 0 typo
  const hex = s.replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
  if (hex.length !== 6) return null;
  return `Pentair: ${hex.slice(0, 2)}-${hex.slice(2, 4)}-${hex.slice(4, 6)}`;
}

// ─── Auth ────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === "/healthz" && req.method === "GET") {
    // Allow unauthed health for tunnel diagnostics, but only return uptime.
    return next();
  }
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

// ─── Connection cache ────────────────────────────────────────────────────
// Map<systemName, { client, expiresAt, password }>
const connections = new Map();

async function getClient(systemName, password) {
  const cached = connections.get(systemName);
  if (cached && cached.expiresAt > Date.now() && cached.password === password) {
    return cached.client;
  }
  // Tear down stale entry
  if (cached) {
    try { cached.client.close(); } catch {}
    connections.delete(systemName);
  }

  const gateway = new RemoteLogin(systemName);
  let gatewayData;
  try {
    gatewayData = await gateway.connectAsync();
  } finally {
    try { await gateway.closeAsync(); } catch {}
  }
  if (!gatewayData || !gatewayData.gatewayFound) {
    throw new Error(
      `Gateway not found for ${systemName}. Pentair dispatcher returned gatewayFound=false. ` +
        "Check the system name and confirm this Pi has a residential IP.",
    );
  }

  const client = new UnitConnection();
  client.init(systemName, gatewayData.ipAddr, gatewayData.port, password);
  await client.connectAsync();

  // Drop the cache entry if the underlying socket dies
  client.on?.("close", () => connections.delete(systemName));
  client.on?.("error", () => connections.delete(systemName));

  connections.set(systemName, {
    client,
    password,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  return client;
}

/**
 * Pull current pool/spa temperatures + heater state from a connected client.
 * Shape mirrors what the cloud `screenlogic-control` function returns to
 * keep parity with the iAquaLink interface used by the rest of the app.
 */
async function fetchStatus(client) {
  const [equip, controllerCfg] = await Promise.all([
    client.equipment.getEquipmentStateAsync(),
    client.controller.getControllerConfigAsync().catch(() => null),
  ]);

  // node-screenlogic surfaces bodies as an array; index 0 is typically pool, 1 spa.
  const bodies = equip?.bodies || equip?.bodyArray || [];
  const pool = bodies[0] || {};
  const spa = bodies[1] || {};

  // heatStatus: 0 off, non-zero = heating
  const heaterStr = (h) => (h && Number(h) > 0 ? "1" : "0");

  return {
    pool_temp: pool.currentTemp ?? pool.currentTemperature ?? pool.lastTemperature ?? null,
    pool_set_point: pool.heatSetPoint ?? pool.setPoint ?? null,
    pool_heater: heaterStr(pool.heatStatus),
    spa_temp: spa.currentTemp ?? spa.currentTemperature ?? spa.lastTemperature ?? null,
    spa_set_point: spa.heatSetPoint ?? spa.setPoint ?? null,
    spa_heater: heaterStr(spa.heatStatus),
    air_temp: equip?.airTemp ?? equip?.airTemperature ?? null,
    raw: { equip, controllerCfg },
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────
app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    cached_systems: connections.size,
    version: "1.0.0",
  });
});

app.post("/api/pool/status", async (req, res) => {
  const { systemName: rawName, password } = req.body || {};
  if (!rawName) {
    return res.status(400).json({ error: "systemName required" });
  }
  const systemName = normalizeSystemName(rawName);
  if (!systemName) {
    return res.status(400).json({
      error: `Invalid systemName "${rawName}". Expected 6-char hex like "0C-B6-F9".`,
    });
  }
  try {
    const client = await getClient(systemName, password ?? "");
    const status = await fetchStatus(client);
    res.json({ success: true, status });
  } catch (e) {
    console.error(`status ${systemName}:`, e.message);
    connections.delete(systemName);
    res.status(502).json({ error: e.message });
  }
});

app.post("/api/pool/heater", async (req, res) => {
  const { systemName: rawName, password, temp, body: bodyType = "pool" } = req.body || {};
  if (!rawName) {
    return res.status(400).json({ error: "systemName required" });
  }
  const systemName = normalizeSystemName(rawName);
  if (!systemName) {
    return res.status(400).json({
      error: `Invalid systemName "${rawName}". Expected 6-char hex like "0C-B6-F9".`,
    });
  }
  const t = Number(temp);
  if (!Number.isFinite(t) || t < 50 || t > 110) {
    return res.status(400).json({ error: "temp must be 50-110" });
  }
  try {
    const client = await getClient(systemName, password ?? "");
    // bodyType: 0 = pool, 1 = spa
    const bodyId = bodyType === "spa" ? 1 : 0;
    await client.bodies.setSetPointAsync(bodyId, t);

    // Verify by re-reading after a short delay
    await new Promise((r) => setTimeout(r, VERIFY_DELAY_MS));
    const status = await fetchStatus(client);
    const actual =
      bodyId === 0 ? status.pool_set_point : status.spa_set_point;
    const verified = Number(actual) === t;

    res.json({
      success: true,
      actual_temp: typeof actual === "number" ? actual : t,
      verified,
      status,
    });
  } catch (e) {
    console.error(`heater ${systemName}:`, e.message);
    connections.delete(systemName);
    res.status(502).json({ error: e.message });
  }
});

// ─── Boot ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`pool-pi listening on :${PORT}`);
});

// Graceful shutdown — close every cached ScreenLogic connection
function shutdown() {
  console.log("shutting down, closing pool connections…");
  for (const [name, entry] of connections.entries()) {
    try { entry.client.close(); } catch {}
    connections.delete(name);
  }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);