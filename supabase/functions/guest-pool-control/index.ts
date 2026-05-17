import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Public guest pool control endpoint. Reached from /pool/<slug> (no auth).
 * Looks up a home by slug and exposes:
 *  - status        → home info, latest pool/spa temps and setpoints, quiet-time
 *  - set-spa-temp  → clamp to home's spa range, dispatch set-temp on body=spa
 *  - toggle-feature→ look up home_features row, dispatch to iaqualink/screenlogic
 *
 * Quiet time is a global window from `settings.quiet_start_hour` to
 * `settings.quiet_end_hour` in America/Los_Angeles. Spa temp adjustments are
 * always allowed unless `allow_spa_temp_during_quiet` is false. Feature
 * toggles are blocked during quiet time.
 */

function getPacificHour(): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0");
}

function isQuietHour(start: number, end: number, hour = getPacificHour()): boolean {
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  // overnight window e.g. 22 -> 8
  return hour >= start || hour < end;
}

function quietEndDescription(end: number): string {
  const am = end < 12;
  const h = end % 12 === 0 ? 12 : end % 12;
  return `${h}:00 ${am ? "AM" : "PM"}`;
}

// In-memory simple throttle per slug (best-effort; resets on cold start)
const lastActionAt = new Map<string, number>();
function throttled(slug: string, minMs = 5000): boolean {
  const now = Date.now();
  const last = lastActionAt.get(slug) || 0;
  if (now - last < minMs) return true;
  lastActionAt.set(slug, now);
  return false;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const body = await req.json().catch(() => ({}));
    const slug: string = body.slug;
    const action: string = body.action;
    if (!slug || !action) {
      return new Response(JSON.stringify({ error: "slug and action required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: home, error: homeErr } = await supabase
      .from("homes")
      .select("id, name, slug, cover_photo_url, has_spa, spa_min_temp, spa_max_temp, controller_type, controller_enabled, active")
      .eq("slug", slug)
      .eq("active", true)
      .maybeSingle();
    if (homeErr || !home) {
      return new Response(JSON.stringify({ error: "Home not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: settings } = await supabase.from("settings").select("*").maybeSingle();
    const spaMin = home.spa_min_temp ?? settings?.spa_min_temp_default ?? 95;
    const spaMax = home.spa_max_temp ?? settings?.spa_max_temp_default ?? 104;
    const quietStart = settings?.quiet_start_hour ?? 22;
    const quietEnd = settings?.quiet_end_hour ?? 8;
    const allowSpaTempDuringQuiet = settings?.allow_spa_temp_during_quiet ?? true;
    const quietActive = isQuietHour(quietStart, quietEnd);

    if (action === "status") {
      const { data: state } = await supabase
        .from("home_pool_state")
        .select("last_actual_temp, last_actual_setpoint, last_temp_check_at, last_temp_check_error")
        .eq("home_id", home.id)
        .maybeSingle();

      // List active mapped features
      const { data: features } = await supabase
        .from("home_features")
        .select("id, feature_key, label, controller_target, sort_order, icon_key")
        .eq("home_id", home.id)
        .eq("active", true)
        .order("sort_order");

      // Pull live controller status to derive feature on/off + spa temp
      const fnName = home.controller_type === "screenlogic" ? "screenlogic-control" : "iaqualink-control";
      let live: any = null;
      if (home.controller_enabled) {
        try {
          const r = await fetch(`${supabaseUrl}/functions/v1/${fnName}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
            body: JSON.stringify({ action: "get-status", home_id: home.id }),
          });
          const j = await r.json();
          if (j?.success) live = j;
        } catch { /* fall back to cached state */ }
      }
      const liveStatus = live?.status || {};

      // Derive feature state from live status (best-effort)
      const featuresOut = (features || []).map((f) => {
        let stateOn: boolean | null = null;
        const target = f.controller_target || "";
        if (target.startsWith("circuit:") && Array.isArray(liveStatus.circuits)) {
          const cid = Number(target.slice(8));
          const c = liveStatus.circuits.find((c: any) => c.id === cid);
          if (c) stateOn = !!c.state;
        } else if (target.startsWith("aux:")) {
          const v = liveStatus[`aux_${target.slice(4)}_state`];
          if (v != null) stateOn = String(v) === "1";
        } else if (target.startsWith("heater:")) {
          const v = liveStatus[`${target.slice(7)}_heater`];
          if (v != null) stateOn = String(v) === "1";
        }
        return { key: f.feature_key, label: f.label, target, on: stateOn, icon_key: f.icon_key || null };
      });

      // pool / spa temps + setpoints from live (preferred) or cached state
      const parseN = (v: any): number | null => {
        if (v == null) return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      const poolTemp = parseN(liveStatus.pool_temp) ?? state?.last_actual_temp ?? null;
      const spaTemp = parseN(liveStatus.spa_temp);
      const poolSetpoint = parseN(liveStatus.pool_set_point) ?? state?.last_actual_setpoint ?? null;
      const spaSetpoint = parseN(liveStatus.spa_set_point);

      // Derive whether each body is actively circulating so the UI can hide
      // stale temps when the pump is off. Returns null when we can't tell —
      // in that case the UI falls back to showing the temp.
      const bodyActive = (kind: "pool" | "spa"): boolean | null => {
        const pumpVal = liveStatus[`${kind}_pump`];
        if (pumpVal != null) return String(pumpVal) === "1";
        if (Array.isArray(liveStatus.circuits)) {
          const match = liveStatus.circuits.find((c: any) =>
            String(c?.name || "").trim().toLowerCase() === kind
          );
          if (match) return !!match.state;
        }
        // ScreenLogic fallback: if heater is on, body must be circulating
        const heater = liveStatus[`${kind}_heater`];
        if (heater === "1") return true;
        return null;
      };
      const poolActive = bodyActive("pool");
      const spaActive = bodyActive("spa");

      return new Response(JSON.stringify({
        home: {
          name: home.name,
          slug: home.slug,
          cover_photo_url: home.cover_photo_url,
          has_spa: home.has_spa,
          spa_min: spaMin,
          spa_max: spaMax,
          controller_enabled: home.controller_enabled,
        },
        pool_temp: poolTemp,
        spa_temp: spaTemp,
        pool_active: poolActive,
        spa_active: spaActive,
        pool_setpoint: poolSetpoint,
        spa_setpoint: spaSetpoint,
        features: featuresOut,
        live_ok: !!live,
        quiet_active: quietActive,
        quiet_end_label: quietEndDescription(quietEnd),
        allow_spa_temp_during_quiet: allowSpaTempDuringQuiet,
        last_checked_at: state?.last_temp_check_at ?? null,
        last_check_error: state?.last_temp_check_error ?? null,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "set-spa-temp") {
      if (!home.has_spa) {
        return new Response(JSON.stringify({ error: "This home doesn't have a spa" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (quietActive && !allowSpaTempDuringQuiet) {
        return new Response(JSON.stringify({ error: `Quiet hours — try again after ${quietEndDescription(quietEnd)}` }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (throttled(`temp:${slug}`, 3000)) {
        return new Response(JSON.stringify({ error: "Please wait a few seconds before trying again" }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      let temp = Math.round(Number(body.temp));
      if (!Number.isFinite(temp)) {
        return new Response(JSON.stringify({ error: "temp required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      temp = Math.max(spaMin, Math.min(spaMax, temp));
      const fnName = home.controller_type === "screenlogic" ? "screenlogic-control" : "iaqualink-control";
      const payload: any = { action: "set-temp", home_id: home.id, temp };
      if (home.controller_type === "screenlogic") payload.body = "spa";
      else payload.tempIndex = 2; // honored only if controller has dual setpoints; iaqualink-control uses home's configured index
      const r = await fetch(`${supabaseUrl}/functions/v1/${fnName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!r.ok || j?.error) {
        return new Response(JSON.stringify({ error: j?.error || `controller error ${r.status}` }), {
          status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true, temp, verified: j.verified, actual_temp: j.actual_temp }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "toggle-feature") {
      if (quietActive) {
        return new Response(JSON.stringify({ error: `Quiet hours — features are paused until ${quietEndDescription(quietEnd)}` }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (throttled(`toggle:${slug}`, 3000)) {
        return new Response(JSON.stringify({ error: "Please wait a few seconds before trying again" }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const featureKey = String(body.feature_key || "");
      const on = body.on === true;
      const { data: feature } = await supabase
        .from("home_features")
        .select("*")
        .eq("home_id", home.id)
        .eq("feature_key", featureKey)
        .eq("active", true)
        .maybeSingle();
      if (!feature) {
        return new Response(JSON.stringify({ error: "Feature not available" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const target = feature.controller_target || "";
      const fnName = home.controller_type === "screenlogic" ? "screenlogic-control" : "iaqualink-control";
      let payload: any = { home_id: home.id };
      if (target.startsWith("circuit:")) {
        payload = { ...payload, action: "set-circuit", circuit_id: parseInt(target.slice(8), 10), on };
      } else if (target.startsWith("aux:")) {
        payload = { ...payload, action: "set-aux", aux_index: parseInt(target.slice(4), 10), on };
      } else if (target.startsWith("heater:")) {
        payload = { ...payload, action: "set-heater", heater: target.slice(7).trim().split(/\s+/)[0], on };
      } else {
        return new Response(JSON.stringify({ error: `Unknown target ${target}` }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const r = await fetch(`${supabaseUrl}/functions/v1/${fnName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!r.ok || j?.error) {
        return new Response(JSON.stringify({ error: j?.error || `controller error ${r.status}` }), {
          status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true, on, verified: j.verified }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("guest-pool-control error:", e);
    return new Response(JSON.stringify({ error: e.message || String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});