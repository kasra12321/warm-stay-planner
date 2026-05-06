/**
 * Pool Heat — Raspberry Pi bridge server
 *
 * Connection management note (v1.5.1):
 *   v1.5 introduced a bug where a Promise.race timeout would leave the
 *   underlying connectAsync promise dangling. When it eventually rejected
 *   (after our timeout already fired), Node treated it as an unhandled
 *   rejection and crashed the process. v1.5.1 wraps these races so the
 *   loser is always handled, AND adds a top-level unhandledRejection
 *   handler as a safety net so a single bad property can never crash
 *   the service for everyone else.
 */

const express = require("express");
const { RemoteLogin, UnitConnection } = require("node-screenlogic");

const PORT = parseInt(process.env.PORT || "8787", 10);
const AUTH_TOKEN = process.env.PI_AUTH_TOKEN;
const VERIFY_DELAY_MS = 1500;
const REQUEST_TIMEOUT_MS = 25_000;
const CONNECTION_CACHE_TTL_MS = 60_000;
const MAX_LISTENERS_BEFORE_RECYCLE = 5;
const GATEWAY_TIMEOUT_MS = 10_000;
const UNIT_CONNECT_TIMEOUT_MS = 10_000;

if (!AUTH_TOKEN) {
  console.error("FATAL: PI_AUTH_TOKEN env var is required");
  process.exit(1);
}

// Top-level safety nets — never let one bad request take down the whole
// service. We log and move on; the request that triggered the rejection
// has already returned 502 to its caller.
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(`[unhandledRejection] ${msg}`);
});
process.on("uncaughtException", (err) => {
  console.error(`[uncaughtException] ${err.message}\n${err.stack}`);
  // Stay alive — we'd rather degrade than die.
});

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

const connections = new Map();
const locks = new Map();

function listenerCountTooHigh(client) {
  if (!client || typeof client.eventNames !== "function") return false;
  for (const evt of client.eventNames()) {
    if (client.listenerCount(evt) >= MAX_LISTENERS_BEFORE_RECYCLE) return true;
  }
  return false;
}

function disposeClient(client) {
  if (!client) return;
  try { client.removeAllListeners?.(); } catch {}
  try { client.close(); } catch {}
}

/**
 * Race a promise against a timeout. The loser is always handled, so neither
 * branch can produce an unhandled rejection. This is the v1.5.1 fix.
 *
 * If the underlying promise loses the race, we attach a no-op .catch() to
 * silently absorb its eventual rejection (or resolution). The original
 * resource is already being torn down by the caller's catch path.
 */
function raceWithTimeout(promise, ms, errorMessage) {
  let timeoutId;
  const timeout = new Promise((_, rej) => {
    timeoutId = setTimeout(() => rej(new Error(errorMessage)), ms);
  });
  return Promise.race([promise, timeout])
    .finally(() => clearTimeout(timeoutId))
    // If `promise` eventually rejects AFTER the timeout already fired, attach
    // a swallow handler so it doesn't become an unhandled rejection. This is
    // safe because the caller has already moved on with our error.
    .catch((err) => {
      promise.catch(() => {});  // attach NOW to silence late rejection
      throw err;
    });
}

async function openConnection(systemName, password) {
  const gateway = new RemoteLogin(systemName);
  let gatewayData;
  try {
    gatewayData = await raceWithTimeout(
      gateway.connectAsync(),
      GATEWAY_TIMEOUT_MS,
      "gateway timeout",
    );
  } finally {
    try { await gateway.closeAsync(); } catch {}
  }
  if (!gatewayData || !gatewayData.gatewayFound) {
    throw new Error(
      `Gateway not found for ${systemName}. Pentair dispatcher returned gatewayFound=false. ` +
        "Check the system name and confirm this property's ScreenLogic adapter is online.",
    );
  }

  const client = new UnitConnection();
  client.init(systemName, gatewayData.ipAddr, gatewayData.port, password);
  // Pre-attach a swallow handler in case `connectAsync` rejects after our
  // timeout already fired and the caller has moved on.
  const connectPromise = client.connectAsync();
  try {
    await raceWithTimeout(connectPromise, UNIT_CONNECT_TIMEOUT_MS, "unit connect timeout");
  } catch (e) {
    // Make absolutely sure the underlying promise can't bubble up later
    connectPromise.catch(() => {});
    disposeClient(client);
    throw e;
  }

  return client;
}

async function getOrOpenClient(systemName, password) {
  const cached = connections.get(systemName);
  if (cached && cached.expiresAt > Date.now() && cached.password === password) {
    if (listenerCountTooHigh(cached.client)) {
      console.log(`[recycle] ${systemName} (listener accumulation)`);
      disposeClient(cached.client);
      connections.delete(systemName);
    } else {
      cached.expiresAt = Date.now() + CONNECTION_CACHE_TTL_MS;
      return cached.client;
    }
  } else if (cached) {
    disposeClient(cached.client);
    connections.delete(systemName);
  }

  const client = await openConnection(systemName, password);
  connections.set(systemName, {
    client,
    password,
    expiresAt: Date.now() + CONNECTION_CACHE_TTL_MS,
  });
  return client;
}

async function withConnection(systemName, password, handler) {
  const prev = locks.get(systemName);
  if (prev) {
    try { await prev; } catch {}
  }

  let resolveLock, rejectLock;
  const lock = new Promise((res, rej) => { resolveLock = res; rejectLock = rej; });
  locks.set(systemName, lock);

  const startedAt = Date.now();
  let client;
  try {
    client = await getOrOpenClient(systemName, password);
    const handlerPromise = handler(client);
    const result = await raceWithTimeout(
      handlerPromise,
      REQUEST_TIMEOUT_MS,
      "handler timeout",
    );
    const elapsed = Date.now() - startedAt;
    console.log(`[ok] ${systemName} (${elapsed}ms)`);
    resolveLock();
    return result;
  } catch (e) {
    if (client) {
      const cached = connections.get(systemName);
      if (cached && cached.client === client) {
        connections.delete(systemName);
      }
      disposeClient(client);
    }
    rejectLock(e);
    throw e;
  } finally {
    if (locks.get(systemName) === lock) locks.delete(systemName);
  }
}

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
    cached_connections: connections.size,
    in_flight_locks: locks.size,
    version: "1.5.1",
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
      try { config = await client.equipment.getControllerConfigAsync(); }
      catch (e) { configError = e.message; }
      let circuitDefs = null, circuitDefsError = null;
      try { circuitDefs = await client.equipment.getCircuitDefinitionsAsync(); }
      catch (e) { circuitDefsError = e.message; }
      let customNames = null, customNamesError = null;
      try { customNames = await client.equipment.getCustomNamesAsync(); }
      catch (e) { customNamesError = e.message; }
      return { equip, config, configError, circuitDefs, circuitDefsError, customNames, customNamesError };
    });
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
// ============================================================
// iAquaLink passthrough — forward arbitrary iAquaLink API calls
// from the cloud through this Pi's residential IP. iAquaLink
// rate-limits Cloudflare's IP pool but not residential IPs, so
// routing here lets the cloud avoid the rate limit.
//
// The Pi is a STATELESS proxy. No iAquaLink credentials are stored.
// Cloud sends credentials in each call body, we forward to iAquaLink,
// return the response.
// ============================================================

const IAQUA_ALLOWED_HOSTS = new Set([
  "prod.zodiac-io.com",
  "r-api.iaqualink.net",
  "p-api.iaqualink.net",
]);

app.post("/api/iaqua/proxy", async (req, res) => {
  const { method, url, body } = req.body || {};

  // Validation
  if (!method || (method !== "GET" && method !== "POST")) {
    return res.status(400).json({ error: "method must be GET or POST" });
  }
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "url is required" });
  }

  // Whitelist iAquaLink hosts only — prevent the proxy from being abused
  // to hit arbitrary URLs.
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: "invalid url" });
  }
  if (!IAQUA_ALLOWED_HOSTS.has(parsed.hostname)) {
    console.warn(`[iaqua-proxy] blocked non-iAquaLink host: ${parsed.hostname}`);
    return res.status(403).json({ error: "host not allowed" });
  }

  const headers = {
    Accept: "application/json",
    "User-Agent": "okhttp/3.14.7",
  };
  if (method === "POST") {
    headers["Content-Type"] = "application/json";
  }

  const fetchOpts = { method, headers };
  if (method === "POST" && body !== null && body !== undefined) {
    fetchOpts.body = JSON.stringify(body);
  }

  try {
    const start = Date.now();
    const upstream = await fetch(url, fetchOpts);
    const elapsed = Date.now() - start;
    const text = await upstream.text();
    console.log(`[iaqua-proxy] ${method} ${parsed.hostname}${parsed.pathname} → ${upstream.status} (${elapsed}ms)`);
    return res.json({ status: upstream.status, body: text });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    console.error(`[iaqua-proxy] fetch failed for ${url}: ${msg}`);
    return res.status(502).json({ error: "upstream fetch failed", detail: msg });
  }
});
app.listen(PORT, () => {
  console.log(`pool-pi listening on :${PORT}`);
});

function shutdown() {
  console.log("shutting down…");
  for (const [name, entry] of connections.entries()) {
    disposeClient(entry.client);
    connections.delete(name);
  }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
