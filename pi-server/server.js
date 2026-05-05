/**
 * Pool Heat — Raspberry Pi bridge server
 *
 * Runs on a Raspberry Pi at a residential address. Pentair's RemoteLogin
 * dispatcher (screenlogicserver.pentair.com:500) silently rejects requests
 * from datacenter IPs, so the Lovable cloud backend cannot talk to it
 * directly. This server proxies those calls so they originate from the Pi's
 * residential IP.
 *
 * Auth: Bearer token in `Authorization: Bearer <PI_AUTH_TOKEN>` header.
 *
 * Endpoints:
 *   GET  /healthz                  → uptime + version
 *   POST /api/pool/status          → temps, heater state, AND named circuits
 *   POST /api/pool/heater          → set heater target temp
 *   POST /api/pool/circuits        → list named circuits
 *   POST /api/pool/circuit         → toggle a single circuit
 *   POST /api/pool/raw             → DEBUG: dumps full equip + config
 *
 * Connection management note (v1.4): node-screenlogic 2.x leaks event
 * listeners on a UnitConnection across repeated calls — repeated reads of
 * the same connection eventually exhaust listener limits and hang. The
 * previous 5-minute connection cache was running into this in production.
 * v1.4 opens a fresh connection per request and closes it deterministically
 * before responding. The Supabase-side 30s response cache absorbs most of
 * the perf cost.
 */

const express = require("express");
const { RemoteLogin, UnitConnection } = require("node-screenlogic");

const PORT = parseInt(process.env.PORT || "8787", 10);
const AUTH_TOKEN = process.env.PI_AUTH_TOKEN;
const VERIFY_DELAY_MS = 1500;
const REQUEST_TIMEOUT_MS = 25_000;

if (!AUTH_TOKEN) {
  console.error("FATAL: PI_AUTH_TOKEN env var is required");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "32kb" }));

app.use((req, _res, next) => {
  console.log(`[req] ${req.method} ${req.path} from ${req.ip} systemName=${req.body?.systemName || "-"}`);
  next();
});

function normalizeSystemName(input) {
  if (!input) return null;
  let s = String(input).trim();
  s = s.replace(/^pentair\s*:\s*/i, "");
  s = s.replace(/O/gi, "0");
  const hex = s.replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
  if (hex.length !== 6) return null;
  return `Pentair: ${hex.slice(0, 2)}-${hex.slice(2, 4)}-${hex.slice(4, 6)}`;
}

app.use((req, res, next) => {
  if (req.path === "/healthz" && req.method === "GET") return next();
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

/**
 * Wrap a UnitConnection's lifecycle so the caller doesn't have to remember
 * to close it. We do gateway lookup → connect → run handler → close, with
 * a hard timeout in case anything in node-screenlogic hangs.
 *
 * Each call to this function opens a fresh connection. There's no caching.
 * This is deliberate — node-screenlogic 2.x leaks listeners on reused
 * connections and eventually starts hanging. Fresh-per-request is reliable.
 */
async function withConnection(systemName, password, handler) {
  const startedAt = Date.now();

  // Step 1: gateway lookup (RemoteLogin)
  const gateway = new RemoteLogin(systemName);
  let gatewayData;
  try {
    gatewayData = await Promise.race([
      gateway.connectAsync(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("gateway timeout")), 10_000)),
    ]);
  } finally {
    try { await gateway.closeAsync(); } catch {}
  }
  if (!gatewayData || !gatewayData.gatewayFound) {
    throw new Error(
      `Gateway not found for ${systemName}. Pentair dispatcher returned gatewayFound=false. ` +
        "Check the system name and confirm this property's ScreenLogic adapter is online.",
    );
  }

  // Step 2: connect to the actual unit
  const client = new UnitConnection();
  client.init(systemName, gatewayData.ipAddr, gatewayData.port, password);
  try {
    await Promise.race([
      client.connectAsync(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("unit connect timeout")), 10_000)),
    ]);
  } catch (e) {
    try { client.close(); } catch {}
    throw e;
  }

  // Step 3: run the caller's handler with a hard timeout
  try {
    const result = await Promise.race([
      handler(client),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("handler timeout")), REQUEST_TIMEOUT_MS),
      ),
    ]);
    const elapsed = Date.now() - startedAt;
    console.log(`[ok] ${systemName} (${elapsed}ms)`);
    return result;
  } finally {
    // Step 4: ALWAYS close, even on error. Leaving connections open is
    // what was causing the listener-leak issue.
    try { client.close(); } catch {}
  }
}

/**
 * Fetch the controller config (circuit names + roles) and merge with live
 * state (which circuits are currently on/off) into one normalized object.
 */
async function fetchStatus(client) {
  const [equip, config] = await Promise.all([
    client.equipment.getEquipmentStateAsync(),
    client.equipment.getControllerConfigAsync().catch((e) => {
      console.error(`config fetch failed: ${e.message}`);
      return null;
    }),
  ]);

  const bodies = equip?.bodies || equip?.bodyArray || [];
  const pool = bodies[0] || {};
  const spa = bodies[1] || {};
  const heaterStr = (h) => (h && Number(h) > 0 ? "1" : "0");

  // Merge live circuit state with config metadata
  const stateById = new Map();
  for (const c of equip?.circuitArray || equip?.circuits || []) {
    const id = c.id ?? c.circuitId;
    if (id != null) stateById.set(id, c.state === 1 || c.state === true || c.state === "1");
  }

  const circuits = [];
  const configCircuits = config?.circuitArray || config?.circuits || [];
  for (const c of configCircuits) {
    const id = c.circuitId ?? c.id;
    if (id == null) continue;
    circuits.push({
      id,
      name: (c.name || "").trim(),
      state: stateById.has(id) ? stateById.get(id) : false,
      function: typeof c.function === "number" ? c.function : null,
      interface: typeof c.interface === "number" ? c.interface : null,
      live: stateById.has(id),
    });
  }

  // Fallback if config gave nothing — return live entries with empty names
  if (circuits.length === 0) {
    for (const [id, state] of stateById.entries()) {
      circuits.push({ id, name: "", state, function: null, interface: null, live: true });
    }
  }

  return {
    pool_temp: pool.currentTemp ?? pool.currentTemperature ?? pool.lastTemperature ?? null,
    pool_set_point: pool.heatSetPoint ?? pool.setPoint ?? null,
    pool_heater: heaterStr(pool.heatStatus),
    spa_temp: spa.currentTemp ?? spa.currentTemperature ?? spa.lastTemperature ?? null,
    spa_set_point: spa.heatSetPoint ?? spa.setPoint ?? null,
    spa_heater: heaterStr(spa.heatStatus),
    air_temp: equip?.airTemp ?? equip?.airTemperature ?? null,
    circuits,
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────
app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    version: "1.4.0",
  });
});

app.post("/api/pool/status", async (req, res) => {
  const { systemName: rawName, password } = req.body || {};
  if (!rawName) return res.status(400).json({ error: "systemName required" });
  const systemName = normalizeSystemName(rawName);
  if (!systemName) {
    return res.status(400).json({
      error: `Invalid systemName "${rawName}". Expected 6-char hex like "0C-B6-F9".`,
    });
  }
  try {
    const status = await withConnection(systemName, password ?? "", (client) =>
      fetchStatus(client),
    );
    res.json({ success: true, status });
  } catch (e) {
    console.error(`status ${systemName}:`, e.message);
    res.status(502).json({ error: e.message });
  }
});

app.post("/api/pool/heater", async (req, res) => {
  const { systemName: rawName, password, temp, body: bodyType = "pool" } = req.body || {};
  if (!rawName) return res.status(400).json({ error: "systemName required" });
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
    const result = await withConnection(systemName, password ?? "", async (client) => {
      const bodyId = bodyType === "spa" ? 1 : 0;
      await client.bodies.setSetPointAsync(bodyId, t);
      await new Promise((r) => setTimeout(r, VERIFY_DELAY_MS));
      const status = await fetchStatus(client);
      const actual = bodyId === 0 ? status.pool_set_point : status.spa_set_point;
      const verified = Number(actual) === t;
      return { actual, verified, status };
    });
    res.json({
      success: true,
      actual_temp: typeof result.actual === "number" ? result.actual : t,
      verified: result.verified,
      status: result.status,
    });
  } catch (e) {
    console.error(`heater ${systemName}:`, e.message);
    res.status(502).json({ error: e.message });
  }
});

app.post("/api/pool/circuits", async (req, res) => {
  const { systemName: rawName, password } = req.body || {};
  if (!rawName) return res.status(400).json({ error: "systemName required" });
  const systemName = normalizeSystemName(rawName);
  if (!systemName) {
    return res.status(400).json({
      error: `Invalid systemName "${rawName}". Expected 6-char hex like "0C-B6-F9".`,
    });
  }
  try {
    const status = await withConnection(systemName, password ?? "", (client) =>
      fetchStatus(client),
    );
    res.json({ success: true, circuits: status.circuits });
  } catch (e) {
    console.error(`circuits ${systemName}:`, e.message);
    res.status(502).json({ error: e.message });
  }
});

app.post("/api/pool/circuit", async (req, res) => {
  const { systemName: rawName, password, circuitId, on } = req.body || {};
  if (!rawName) return res.status(400).json({ error: "systemName required" });
  const systemName = normalizeSystemName(rawName);
  if (!systemName) {
    return res.status(400).json({
      error: `Invalid systemName "${rawName}". Expected 6-char hex like "0C-B6-F9".`,
    });
  }
  const cid = Number(circuitId);
  if (!Number.isInteger(cid) || cid < 1 || cid > 999) {
    return res.status(400).json({ error: "circuitId must be a positive integer" });
  }
  if (typeof on !== "boolean") {
    return res.status(400).json({ error: "`on` must be true or false" });
  }
  try {
    const result = await withConnection(systemName, password ?? "", async (client) => {
      await client.circuits.setCircuitStateAsync(cid, on);
      await new Promise((r) => setTimeout(r, VERIFY_DELAY_MS));
      const status = await fetchStatus(client);
      const found = status.circuits.find((c) => c.id === cid);
      const verified = !!found && found.state === on;
      return {
        circuit_id: cid,
        desired_state: on,
        actual_state: found?.state ?? null,
        verified,
        status,
      };
    });
    res.json({ success: true, ...result });
  } catch (e) {
    console.error(`circuit ${systemName} ${cid}=${on}:`, e.message);
    res.status(502).json({ error: e.message });
  }
});

app.post("/api/pool/raw", async (req, res) => {
  const { systemName: rawName, password } = req.body || {};
  const systemName = normalizeSystemName(rawName);
  if (!systemName) return res.status(400).json({ error: "bad systemName" });
  try {
    const result = await withConnection(systemName, password ?? "", async (client) => {
      const equip = await client.equipment.getEquipmentStateAsync();

      let config = null, configError = null;
      try {
        config = await client.equipment.getControllerConfigAsync();
      } catch (e) { configError = e.message; }

      let circuitDefs = null, circuitDefsError = null;
      try {
        circuitDefs = await client.equipment.getCircuitDefinitionsAsync();
      } catch (e) { circuitDefsError = e.message; }

      let customNames = null, customNamesError = null;
      try {
        customNames = await client.equipment.getCustomNamesAsync();
      } catch (e) { customNamesError = e.message; }

      return { equip, config, configError, circuitDefs, circuitDefsError, customNames, customNamesError };
    });
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`pool-pi listening on :${PORT}`);
});

function shutdown() {
  console.log("shutting down…");
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
