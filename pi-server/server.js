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
 * Implementation note: ScreenLogic returns LIVE state (which circuits are on/off)
 * via getEquipmentStateAsync(), and CONFIG (circuit names + roles) via
 * getControllerConfigAsync(). Neither alone has both. We merge them.
 */

const express = require("express");
const { RemoteLogin, UnitConnection } = require("node-screenlogic");

const PORT = parseInt(process.env.PORT || "8787", 10);
const AUTH_TOKEN = process.env.PI_AUTH_TOKEN;
const CACHE_TTL_MS = 5 * 60 * 1000;
const VERIFY_DELAY_MS = 1500;

// Cache controller config per system. Config (circuit names, layout) only
// changes when the operator reconfigures their Pentair install — once an hour
// is plenty.
const CONFIG_CACHE_TTL_MS = 60 * 60 * 1000;
const configCache = new Map(); // Map<systemName, { config, expiresAt }>

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
  if (req.path === "/healthz" && req.method === "GET") {
    return next();
  }
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

const connections = new Map();

async function getClient(systemName, password) {
  const cached = connections.get(systemName);
  if (cached && cached.expiresAt > Date.now() && cached.password === password) {
    return cached.client;
  }
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

  client.on?.("close", () => {
    connections.delete(systemName);
    configCache.delete(systemName);
  });
  client.on?.("error", () => {
    connections.delete(systemName);
    configCache.delete(systemName);
  });

  connections.set(systemName, {
    client,
    password,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  return client;
}

/**
 * Fetch (and cache) the controller config. This is what gives us circuit
 * names, function codes, and interface placement.
 */
async function getConfig(systemName, client) {
  const hit = configCache.get(systemName);
  if (hit && hit.expiresAt > Date.now()) return hit.config;

  const config = await client.equipment.getControllerConfigAsync();
  configCache.set(systemName, {
    config,
    expiresAt: Date.now() + CONFIG_CACHE_TTL_MS,
  });
  return config;
}

/**
 * Merge live circuit state (from getEquipmentStateAsync) with config metadata
 * (from getControllerConfigAsync). Returns one entry per circuit with id,
 * name, current state, and useful metadata for the cloud's mapping UI.
 */
function buildCircuits(equip, config) {
  const stateById = new Map();
  const liveCircuits = equip?.circuitArray || equip?.circuits || [];
  for (const c of liveCircuits) {
    const id = c.id ?? c.circuitId;
    if (id == null) continue;
    stateById.set(id, c.state === 1 || c.state === true || c.state === "1");
  }

  const configCircuits = config?.circuitArray || config?.circuits || [];
  const merged = [];
  for (const c of configCircuits) {
    const id = c.circuitId ?? c.id;
    if (id == null) continue;
    merged.push({
      id,
      name: (c.name || "").trim(),
      state: stateById.has(id) ? stateById.get(id) : false,
      function: typeof c.function === "number" ? c.function : null,
      interface: typeof c.interface === "number" ? c.interface : null,
      // Helpful flag — whether this circuit appears in live equipment state.
      // If false, the operator may have configured it but it's not currently
      // wired/active.
      live: stateById.has(id),
    });
  }

  // Fallback: if config gave us nothing for some reason, surface live entries
  // by id alone. Names will be empty but at least IDs/state are correct.
  if (merged.length === 0) {
    for (const [id, state] of stateById.entries()) {
      merged.push({ id, name: "", state, function: null, interface: null, live: true });
    }
  }

  return merged;
}

async function fetchStatus(client, systemName) {
  const equip = await client.equipment.getEquipmentStateAsync();
  let config = null;
  try {
    config = await getConfig(systemName, client);
  } catch (e) {
    // If config fetch fails, we still return circuits from live state (no names)
    console.error(`config fetch failed for ${systemName}: ${e.message}`);
  }

  const bodies = equip?.bodies || equip?.bodyArray || [];
  const pool = bodies[0] || {};
  const spa = bodies[1] || {};
  const heaterStr = (h) => (h && Number(h) > 0 ? "1" : "0");

  return {
    pool_temp: pool.currentTemp ?? pool.currentTemperature ?? pool.lastTemperature ?? null,
    pool_set_point: pool.heatSetPoint ?? pool.setPoint ?? null,
    pool_heater: heaterStr(pool.heatStatus),
    spa_temp: spa.currentTemp ?? spa.currentTemperature ?? spa.lastTemperature ?? null,
    spa_set_point: spa.heatSetPoint ?? spa.setPoint ?? null,
    spa_heater: heaterStr(spa.heatStatus),
    air_temp: equip?.airTemp ?? equip?.airTemperature ?? null,
    circuits: buildCircuits(equip, config),
    raw: { equip },
  };
}

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    cached_systems: connections.size,
    cached_configs: configCache.size,
    version: "1.3.0",
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
    const client = await getClient(systemName, password ?? "");
    const status = await fetchStatus(client, systemName);
    res.json({ success: true, status });
  } catch (e) {
    console.error(`status ${systemName}:`, e.message);
    connections.delete(systemName);
    configCache.delete(systemName);
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
    const client = await getClient(systemName, password ?? "");
    const bodyId = bodyType === "spa" ? 1 : 0;
    await client.bodies.setSetPointAsync(bodyId, t);

    await new Promise((r) => setTimeout(r, VERIFY_DELAY_MS));
    const status = await fetchStatus(client, systemName);
    const actual = bodyId === 0 ? status.pool_set_point : status.spa_set_point;
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
    configCache.delete(systemName);
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
    const client = await getClient(systemName, password ?? "");
    const status = await fetchStatus(client, systemName);
    res.json({ success: true, circuits: status.circuits });
  } catch (e) {
    console.error(`circuits ${systemName}:`, e.message);
    connections.delete(systemName);
    configCache.delete(systemName);
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
    const client = await getClient(systemName, password ?? "");
    await client.circuits.setCircuitStateAsync(cid, on);

    await new Promise((r) => setTimeout(r, VERIFY_DELAY_MS));
    const status = await fetchStatus(client, systemName);
    const found = status.circuits.find((c) => c.id === cid);
    const verified = !!found && found.state === on;

    res.json({
      success: true,
      circuit_id: cid,
      desired_state: on,
      actual_state: found?.state ?? null,
      verified,
      status,
    });
  } catch (e) {
    console.error(`circuit ${systemName} ${cid}=${on}:`, e.message);
    connections.delete(systemName);
    configCache.delete(systemName);
    res.status(502).json({ error: e.message });
  }
});

// DEBUG endpoint — dumps everything we read from the controller. Useful for
// diagnosing new firmwares or unexpected setups.
app.post("/api/pool/raw", async (req, res) => {
  const { systemName: rawName, password } = req.body || {};
  const systemName = normalizeSystemName(rawName);
  if (!systemName) return res.status(400).json({ error: "bad systemName" });
  try {
    const client = await getClient(systemName, password ?? "");

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

    res.json({
      success: true,
      equip,
      config,
      configError,
      circuitDefs,
      circuitDefsError,
      customNames,
      customNamesError,
    });
  } catch (e) {
    connections.delete(systemName);
    configCache.delete(systemName);
    res.status(502).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`pool-pi listening on :${PORT}`);
});

function shutdown() {
  console.log("shutting down, closing pool connections…");
  for (const [name, entry] of connections.entries()) {
    try { entry.client.close(); } catch {}
    connections.delete(name);
  }
  configCache.clear();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
