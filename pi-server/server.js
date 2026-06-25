/**
 * Pool Heat — Raspberry Pi bridge server (v1.8)
 *
 * v1.8: CRITICAL FIX — disposeClient() was calling client.close() which
 *   does not exist in node-screenlogic 2.x; the correct method is
 *   closeAsync(). The TypeError was being silently swallowed by the
 *   try/catch, so connections were NEVER being torn down. Each failed
 *   connection attempt leaked a socket + closure scope, causing the
 *   memory guard to fire every ~3 minutes. This release:
 *     - Calls closeAsync() with a 3s race-timeout
 *     - Force-destroys the underlying client.client socket as a fallback
 *     - Awaits dispose everywhere so cleanup completes before we move on
 *
 * v1.7: Added /api/iaqua/proxy with built-in rate limiting and memory safety.
 * v1.5.1: Race-with-timeout fix to prevent unhandled promise rejections.
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
const DISPOSE_TIMEOUT_MS = 3_000;

if (!AUTH_TOKEN) {
  console.error("FATAL: PI_AUTH_TOKEN env var is required");
  process.exit(1);
}

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(`[unhandledRejection] ${msg}`);
});
process.on("uncaughtException", (err) => {
  console.error(`[uncaughtException] ${err.message}\n${err.stack}`);
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

/**
 * Properly close a node-screenlogic UnitConnection.
 *
 * v1.8 fix: the old version called client.close(), which DOES NOT EXIST
 * in node-screenlogic 2.x. The TypeError was caught silently, so we were
 * leaking sockets on every dispose. The right method is closeAsync().
 *
 * We race closeAsync() against a short timeout so a hung close can't
 * wedge the request path, and as a final belt-and-suspenders we destroy
 * the underlying TCP socket directly (exposed as client.client by the
 * library — yes, the naming is unfortunate).
 */
async function disposeClient(client) {
  if (!client) return;
  try { client.removeAllListeners?.(); } catch {}
  try {
    if (typeof client.closeAsync === "function") {
      await Promise.race([
        client.closeAsync(),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("close timeout")), DISPOSE_TIMEOUT_MS),
        ),
      ]);
    }
  } catch (e) {
    console.warn(`[dispose] closeAsync failed: ${e.message}, forcing socket destroy`);
  } finally {
    try { client.client?.destroy?.(); } catch {}
  }
}

function raceWithTimeout(promise, ms, errorMessage) {
  let timeoutId;
  const timeout = new Promise((_, rej) => {
    timeoutId = setTimeout(() => rej(new Error(errorMessage)), ms);
  });
  return Promise.race([promise, timeout])
    .finally(() => clearTimeout(timeoutId))
    .catch((err) => {
      promise.catch(() => {});
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
  const connectPromise = client.connectAsync();
  try {
    await raceWithTimeout(connectPromise, UNIT_CONNECT_TIMEOUT_MS, "unit connect timeout");
  } catch (e) {
    connectPromise.catch(() => {});
    await disposeClient(client);
    throw e;
  }

  return client;
}

async function getOrOpenClient(systemName, password) {
  const cached = connections.get(systemName);
  if (cached && cached.expiresAt > Date.now() && cached.password === password) {
    if (listenerCountTooHigh(cached.client)) {
      console.log(`[recycle] ${systemName} (listener accumulation)`);
      connections.delete(systemName);
      await disposeClient(cached.client);
    } else {
      cached.expiresAt = Date.now() + CONNECTION_CACHE_TTL_MS;
      return cached.client;
    }
  } else if (cached) {
    connections.delete(systemName);
    await disposeClient(cached.client);
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
  // Pre-attach a swallow handler so a rejected lock with no awaiter
  // (the common case after the first failure) doesn't surface as an
  // unhandled rejection.
  lock.catch(() => {});
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
      await disposeClient(client);
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
    version: "1.8",
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
// iAquaLink passthrough (unchanged from v1.7)
// ============================================================

const IAQUA_ALLOWED_HOSTS = new Set([
  "prod.zodiac-io.com",
  "r-api.iaqualink.net",
  "p-api.iaqualink.net",
]);

const IAQUA_MIN_GAP_MS = 4000;
const IAQUA_MAX_QUEUE = 8;
const IAQUA_FETCH_TIMEOUT_MS = 15_000;

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
        return;
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

  if (iaquaQueueDepth >= IAQUA_MAX_QUEUE) {
    return res
      .status(429)
      .set("Retry-After", "10")
      .json({ error: "pi proxy queue full, retry later" });
  }

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

// Self-healing memory guard. With v1.8's leak fix this should now fire
// rarely or never, but we keep it as a safety net.
const MEMORY_THRESHOLD_MB = 600;
setInterval(() => {
  const mb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  if (mb > MEMORY_THRESHOLD_MB) {
    console.warn(`[memory-guard] ${mb}MB > ${MEMORY_THRESHOLD_MB}MB, restarting`);
    process.exit(0);
  }
}, 10_000);

app.listen(PORT, () => {
  console.log(`pool-pi v1.8 listening on :${PORT}`);
});

async function shutdown() {
  console.log("shutting down…");
  for (const [name, entry] of connections.entries()) {
    await disposeClient(entry.client);
    connections.delete(name);
  }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
