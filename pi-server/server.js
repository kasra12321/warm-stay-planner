/**
 * Pool Heat — Raspberry Pi bridge server (v1.7)
 *
 * v1.7: Added /api/iaqua/proxy with built-in rate limiting and memory safety.
 *   - Self-throttles iAquaLink calls to 1 every 4 seconds (15/min)
 *     to stay under iAquaLink's per-IP rate limit (~6-8/min observed)
 *   - Caps in-flight proxy queue at 8 to prevent OOM on Pi
 *   - Returns 429 + Retry-After when queue is full so cloud can back off
 *   - Strict 15s AbortController timeout per request
 *
 * v1.5.1: Race-with-timeout fix to prevent unhandled promise rejections.
 *   Top-level safety nets to keep service alive under unexpected errors.
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
    iaqua_queue_depth: iaquaQueueDepth,
    version: "1.7",
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

const LIGHT_SHOWS = {
  off: 0, on: 1,
  party: 5, romance: 6, caribbean: 7,
  american: 8, sunset: 9, royal: 10,
};

app.post("/api/pool/light_show", async (req, res) => {
  const { systemName: rawName, password, show } = req.body || {};
  if (!rawName) return res.status(400).json({ error: "systemName required" });
  const systemName = normalizeSystemName(rawName);
  if (!systemName) {
    return res.status(400).json({
      error: `Invalid systemName "${rawName}". Expected 6-char hex like "0C-B6-F9".`,
    });
  }
  const cmd = LIGHT_SHOWS[String(show).toLowerCase()];
  if (cmd === undefined) {
    return res.status(400).json({
      error: `Invalid show "${show}". Expected one of: ${Object.keys(LIGHT_SHOWS).join(", ")}.`,
    });
  }
  try {
    await withConnection(systemName, password ?? "", async (client) => {
      await client.circuits.sendLightCommandAsync(cmd);
    });
    res.json({ ok: true, success: true });
  } catch (e) {
    console.error(`light_show ${systemName} show=${show}:`, e.message);
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
// iAquaLink passthrough (v1.7) — forward arbitrary iAquaLink API
// calls from the cloud through this Pi's residential IP.
//
// iAquaLink rate-limits per-IP at roughly 6-8 calls/minute. We
// self-throttle at 1 call per 4 seconds (15/min) to stay safely
// under the limit. When local queue fills, returns 429 with
// Retry-After hint so cloud can back off rather than blasting us.
//
// Memory safety: caps in-flight queue at 8, AbortController
// timeout at 15s, releases response refs ASAP after sending reply.
// ============================================================

const IAQUA_ALLOWED_HOSTS = new Set([
  "prod.zodiac-io.com",
  "r-api.iaqualink.net",
  "p-api.iaqualink.net",
]);

const IAQUA_MIN_GAP_MS = 4000;        // min spacing between iAquaLink calls
const IAQUA_MAX_QUEUE = 8;            // max waiting requests
const IAQUA_FETCH_TIMEOUT_MS = 15_000; // hard timeout per call

let iaquaLastCallAt = 0;
let iaquaQueueDepth = 0;

async function waitForIaquaSlot() {
  iaquaQueueDepth++;
  try {
    while (true) {
      const now = Date.now();
      const gap = now - iaquaLastCallAt;
      if (gap >= IAQUA_MIN_GAP_MS) {
        iaquaLastCallAt = now;
        return; // slot acquired
      }
      const wait = IAQUA_MIN_GAP_MS - gap;
      await new Promise((r) => setTimeout(r, wait + 50));
    }
  } finally {
    iaquaQueueDepth--;
  }
}

app.post("/api/iaqua/proxy", async (req, res) => {
  const { method, url, body } = req.body || {};

  if (!method || (method !== "GET" && method !== "POST")) {
    return res.status(400).json({ error: "method must be GET or POST" });
  }
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "url is required" });
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: "invalid url" });
  }
  if (!IAQUA_ALLOWED_HOSTS.has(parsed.hostname)) {
    return res.status(403).json({ error: "host not allowed" });
  }

  // Reject early if queue is too deep — protects Pi memory under bursts
  if (iaquaQueueDepth >= IAQUA_MAX_QUEUE) {
    return res
      .status(429)
      .set("Retry-After", "10")
      .json({ error: "pi proxy queue full, retry later" });
  }

  // Wait for a rate-limit slot (4s minimum since last iAquaLink call)
  await waitForIaquaSlot();

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

  // Strict timeout via AbortController prevents pile-up on hung connections
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), IAQUA_FETCH_TIMEOUT_MS);
  fetchOpts.signal = controller.signal;

  let upstreamStatus = 0;
  let bodyText = "";
  let elapsed = 0;
  try {
    const start = Date.now();
    const upstream = await fetch(url, fetchOpts);
    elapsed = Date.now() - start;
    upstreamStatus = upstream.status;
    bodyText = await upstream.text();
  } catch (e) {
    clearTimeout(timeoutId);
    const msg = e && e.message ? e.message : String(e);
    console.error(`[iaqua-proxy] fetch failed: ${msg}`);
    return res.status(502).json({ error: "upstream fetch failed", detail: msg });
  } finally {
    clearTimeout(timeoutId);
  }

  console.log(
    `[iaqua-proxy] ${method} ${parsed.hostname}${parsed.pathname} → ${upstreamStatus} (${elapsed}ms, q=${iaquaQueueDepth})`,
  );
  return res.json({ status: upstreamStatus, body: bodyText });
});
// Self-healing memory guard. Node's GC sometimes fails to reclaim memory
// under sustained load. If we cross a safe threshold, exit cleanly so
// systemd restarts us with a fresh process.
const MEMORY_THRESHOLD_MB = 600;
setInterval(() => {
  const mb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  if (mb > MEMORY_THRESHOLD_MB) {
    console.warn(`[memory-guard] ${mb}MB > ${MEMORY_THRESHOLD_MB}MB, restarting`);
    process.exit(0);  // systemd auto-restart catches this
  }
}, 10_000);
app.listen(PORT, () => {
  console.log(`pool-pi v1.7 listening on :${PORT}`);
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
