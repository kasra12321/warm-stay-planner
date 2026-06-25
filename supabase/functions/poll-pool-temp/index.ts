import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Module-scope settings cache (per-isolate, ~5 min TTL) to avoid re-reading
// the `settings` row on every cron tick.
let SETTINGS_CACHE: { value: any; expires: number } | null = null;
async function getCachedSettings(supabase: any) {
  if (SETTINGS_CACHE && SETTINGS_CACHE.expires > Date.now()) return SETTINGS_CACHE.value;
  const { data } = await supabase.from("settings").select("quiet_start_hour, quiet_end_hour").maybeSingle();
  SETTINGS_CACHE = { value: data || {}, expires: Date.now() + 5 * 60 * 1000 };
  return SETTINGS_CACHE.value;
}

function getPacificHour(): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false });
  return Number(fmt.format(new Date()));
}
function isQuietHour(start: number, end: number, hour = getPacificHour()): boolean {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

function parseIntSafe(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = parseInt(String(v), 10);
  return isNaN(n) ? null : n;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  // Skip during Pacific quiet hours — nobody is viewing the dashboard and
  // pools haven't moved. Cuts roughly a third of daily polls.
  const settings = await getCachedSettings(supabase);
  const quietStart = settings?.quiet_start_hour ?? 22;
  const quietEnd = settings?.quiet_end_hour ?? 8;
  if (isQuietHour(quietStart, quietEnd)) {
    return new Response(JSON.stringify({ ok: true, skipped: "quiet_hours" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Pick the controller-enabled home with the oldest last_temp_check_at
  // (NULL first). One home per invocation; cron runs every 5 minutes so
  // each home is polled roughly every (5 * N) minutes — ~40min for 8 homes.
  const { data: homes, error } = await supabase
    .from("homes")
    .select("id, name, internal_name, controller_type, iaqualink_serial, screenlogic_system_name")
    .eq("controller_enabled", true)
    .eq("active", true);
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const eligible = (homes || []).filter((h) => {
    const t = h.controller_type || "iaqualink";
    return t === "screenlogic" ? !!h.screenlogic_system_name : !!h.iaqualink_serial;
  });
  if (!eligible.length) {
    return new Response(JSON.stringify({ ok: true, message: "no eligible homes" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { data: states } = await supabase
    .from("home_pool_state")
    .select("home_id, last_temp_check_at")
    .in("home_id", eligible.map((h) => h.id));
  const stateMap = new Map<string, string | null>();
  for (const s of states || []) stateMap.set(s.home_id, s.last_temp_check_at);

  // Sort: nulls first, then oldest timestamp
  eligible.sort((a, b) => {
    const ta = stateMap.get(a.id) || null;
    const tb = stateMap.get(b.id) || null;
    if (!ta && !tb) return 0;
    if (!ta) return -1;
    if (!tb) return 1;
    return ta.localeCompare(tb);
  });

  const target = eligible[0];
  const fnName = (target.controller_type || "iaqualink") === "screenlogic"
    ? "screenlogic-control"
    : "iaqualink-control";

  const nowIso = new Date().toISOString();
  let actualTemp: number | null = null;
  let setpoint: number | null = null;
  let errMsg: string | null = null;

  try {
    const r = await fetch(`${supabaseUrl}/functions/v1/${fnName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify({ action: "get-status", home_id: target.id }),
    });
    const j = await r.json();
    if (j?.success && j?.status) {
      const s = j.status;
      if (s.status === "Offline" || s.response === "Error") {
        errMsg = `controller offline${s.error ? `: ${s.error}` : ""}`;
      } else {
        // setpoint: iaqualink-control already normalizes pool_set_point to the
        // active sensor; screenlogic returns pool_set_point directly.
        setpoint = parseIntSafe(s.pool_set_point);
        // actual temp: prefer pool_temp, fallback to spa_temp / temp1 / temp2
        actualTemp =
          parseIntSafe(s.pool_temp) ??
          parseIntSafe(s.spa_temp) ??
          parseIntSafe(s.temp1) ??
          parseIntSafe(s.temp2);
      }
    } else {
      errMsg = j?.error || `bad response (${r.status})`;
    }
  } catch (e: any) {
    errMsg = e?.message || String(e);
  }

  await supabase.from("home_pool_state").upsert(
    {
      home_id: target.id,
      last_temp_check_at: nowIso,
      last_actual_temp: actualTemp,
      last_actual_setpoint: setpoint,
      last_temp_check_error: errMsg,
    },
    { onConflict: "home_id" },
  );

  return new Response(
    JSON.stringify({
      ok: true,
      home: target.internal_name || target.name,
      actual_temp: actualTemp,
      setpoint,
      error: errMsg,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});