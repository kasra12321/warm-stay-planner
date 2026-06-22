import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Auto spa/feature shutoff during quiet hours.
 *
 * Reads settings:
 *   auto_spa_shutoff_enabled (bool)
 *   auto_spa_shutoff_home_ids (uuid[])
 *   auto_spa_shutoff_start_hour / _end_hour (Pacific)
 *   auto_spa_shutoff_interval_minutes
 *   auto_spa_shutoff_last_run_at
 *
 * If we're currently inside the window AND at least interval_minutes have
 * elapsed since last run (or we just entered the window), iterate each
 * selected home and turn off the spa heater and any active home_features.
 */

function getPacificHour(d = new Date()): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0");
}

function inWindow(start: number, end: number, hour = getPacificHour()): boolean {
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const { data: settings } = await supabase.from("settings").select("*").maybeSingle();
    if (!settings) {
      return new Response(JSON.stringify({ skipped: "no-settings" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const enabled = (settings as any).auto_spa_shutoff_enabled;
    const homeIds: string[] = (settings as any).auto_spa_shutoff_home_ids || [];
    const startHour = (settings as any).auto_spa_shutoff_start_hour ?? 22;
    const endHour = (settings as any).auto_spa_shutoff_end_hour ?? 8;
    const intervalMin = (settings as any).auto_spa_shutoff_interval_minutes ?? 30;
    const lastRunAt = (settings as any).auto_spa_shutoff_last_run_at as string | null;

    if (!enabled || homeIds.length === 0) {
      return new Response(JSON.stringify({ skipped: "disabled-or-no-homes" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!inWindow(startHour, endHour)) {
      return new Response(JSON.stringify({ skipped: "outside-window" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (lastRunAt) {
      const elapsedMs = Date.now() - new Date(lastRunAt).getTime();
      if (elapsedMs < intervalMin * 60_000) {
        return new Response(JSON.stringify({ skipped: "interval-not-elapsed", elapsed_ms: elapsedMs }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const { data: homes } = await supabase
      .from("homes")
      .select("id, name, has_spa, controller_type, controller_enabled, active")
      .in("id", homeIds);

    const results: any[] = [];

    for (const home of homes || []) {
      if (!home.active || !home.controller_enabled) {
        results.push({ home: home.name, skipped: "controller-disabled" });
        continue;
      }
      const fnName = home.controller_type === "screenlogic" ? "screenlogic-control" : "iaqualink-control";
      const callCtrl = async (payload: any) => {
        const r = await fetch(`${supabaseUrl}/functions/v1/${fnName}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
          body: JSON.stringify({ ...payload, home_id: home.id }),
        });
        return r.json().catch(() => ({}));
      };

      // Get live status
      const status = await callCtrl({ action: "get-status" });
      const live = status?.status || {};
      const actions: any[] = [];

      // Shut off spa heater if on
      if (home.has_spa && String(live.spa_heater) === "1") {
        const r = await callCtrl({ action: "set-heater", heater: "spa", on: false });
        actions.push({ kind: "spa-heater", ok: !!r?.success, err: r?.error });
      }

      // Iterate active features and turn off any that are on
      const { data: features } = await supabase
        .from("home_features")
        .select("feature_key, label, controller_target")
        .eq("home_id", home.id)
        .eq("active", true);

      for (const f of features || []) {
        const target = f.controller_target || "";
        let isOn: boolean | null = null;
        let payload: any = null;
        if (target.startsWith("circuit:")) {
          const cid = parseInt(target.slice(8), 10);
          const c = Array.isArray(live.circuits) ? live.circuits.find((c: any) => c.id === cid) : null;
          if (c) isOn = !!c.state;
          payload = { action: "set-circuit", circuit_id: cid, on: false };
        } else if (target.startsWith("aux:")) {
          const idx = parseInt(target.slice(4), 10);
          const v = live[`aux_${idx}_state`];
          if (v != null) isOn = String(v) === "1";
          payload = { action: "set-aux", aux_index: idx, on: false };
        } else if (target.startsWith("heater:")) {
          const kind = target.slice(7).trim().split(/\s+/)[0];
          const v = live[`${kind}_heater`];
          if (v != null) isOn = String(v) === "1";
          payload = { action: "set-heater", heater: kind, on: false };
        } else if (target.startsWith("onetouch:")) {
          const idx = parseInt(target.slice(9), 10);
          const v = live[`onetouch_${idx}_state`];
          if (v != null) isOn = String(v) === "1";
          payload = { action: "set-onetouch", onetouch_index: idx, on: false };
        }
        if (isOn && payload) {
          const r = await callCtrl(payload);
          actions.push({ kind: f.feature_key, label: f.label, target, ok: !!r?.success, err: r?.error });
        }
      }

      results.push({ home: home.name, actions });
    }

    await supabase
      .from("settings")
      .update({ auto_spa_shutoff_last_run_at: new Date().toISOString() })
      .eq("id", (settings as any).id);

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("auto-spa-shutoff error:", e);
    return new Response(JSON.stringify({ error: e.message || String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});