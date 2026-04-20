import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface Reservation {
  check_in: string;
  check_out: string;
  status: string;
}

async function fetchReservations(propertyId: string, pat: string): Promise<Reservation[]> {
  // Look back 14 days so currently-occupied stays (check-in before today) are included.
  // Omit date_query=checkin so the API returns reservations overlapping the window, not only those whose check-in falls in it.
  const start = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const end = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const url = `https://public.api.hospitable.com/v2/reservations?properties[]=${encodeURIComponent(
    propertyId,
  )}&start_date=${start}&end_date=${end}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${pat}`, Accept: "application/json" },
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Hospitable ${r.status}: ${t}`);
  }
  const data = await r.json();
  return (data.data || []).filter((res: any) => res.status === "accepted");
}

function decideTemp(
  reservations: Reservation[],
  nowIso: string,
  baseline: number,
  ecoTemp: number,
): { mode: "eco" | "baseline" | "guest_heat"; temp: number; nextCheckin: string | null; reason: string } {
  const now = new Date(nowIso);
  // Find current occupancy
  const current = reservations.find((r) => {
    const ci = new Date(r.check_in);
    const co = new Date(r.check_out);
    return ci <= now && now < co;
  });
  if (current) {
    return { mode: "baseline", temp: baseline, nextCheckin: current.check_in, reason: "occupied" };
  }
  // Find next future check-in
  const future = reservations
    .filter((r) => new Date(r.check_in) > now)
    .sort((a, b) => +new Date(a.check_in) - +new Date(b.check_in));
  const next = future[0] || null;
  if (next) {
    const hoursUntil = (+new Date(next.check_in) - +now) / (1000 * 60 * 60);
    if (hoursUntil <= 24) {
      return { mode: "baseline", temp: baseline, nextCheckin: next.check_in, reason: "checkin within 24h" };
    }
  }
  return { mode: "eco", temp: ecoTemp, nextCheckin: next?.check_in || null, reason: "vacant >24h" };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const pat = Deno.env.get("HOSPITABLE_PAT");
    if (!pat) {
      return new Response(JSON.stringify({ error: "HOSPITABLE_PAT not configured" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(supabaseUrl, serviceKey);

    const { data: homes, error } = await supabase
      .from("homes")
      .select("id, name, internal_name, iaqualink_serial, iaqualink_enabled, iaqualink_baseline_temp, hospitable_property_id, eco_mode_enabled, eco_temp")
      .eq("iaqualink_enabled", true)
      .not("iaqualink_serial", "is", null)
      .not("hospitable_property_id", "is", null);
    if (error) throw error;

    const nowIso = new Date().toISOString();
    const changes: Array<{ home: string; from: string | null; to: string; temp: number; reason: string }> = [];
    const errors: Array<{ home: string; error: string }> = [];

    for (const home of homes || []) {
      try {
        const { data: state } = await supabase
          .from("home_pool_state")
          .select("*")
          .eq("home_id", home.id)
          .maybeSingle();

        // Skip if a guest heat order is active (process-reminders sets this)
        if (state?.current_mode === "guest_heat") {
          await supabase
            .from("home_pool_state")
            .update({ last_occupancy_check: nowIso })
            .eq("home_id", home.id);
          continue;
        }

        const reservations = await fetchReservations(home.hospitable_property_id!, pat);
        const baseline = home.iaqualink_baseline_temp ?? 80;
        const ecoTemp = home.eco_mode_enabled ? (home.eco_temp ?? 75) : baseline;
        const decision = decideTemp(reservations, nowIso, baseline, ecoTemp);

        const homeName = home.internal_name || home.name;

        if (state?.current_target_temp === decision.temp && state?.current_mode === decision.mode) {
          // No decision change. Do a drift check: read the actual pool setpoint
          // and compare to what we think it is. Re-applies + alerts if drifted.
          let driftActual: number | null = null;
          let controllerOffline = false;
          try {
            const verify = await fetch(`${supabaseUrl}/functions/v1/iaqualink-control`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
              body: JSON.stringify({ action: "get-status", home_id: home.id }),
            });
            const vJson = await verify.json();
            if (vJson?.success && vJson?.status) {
              if (vJson.status["status"] === "Offline" || vJson.status["response"] === "Error") {
                controllerOffline = true;
              }
              const candidates = [vJson.status["pool_set_point"], vJson.status["spa_set_point"]];
              for (const c of candidates) {
                const n = parseInt(c, 10);
                if (!isNaN(n) && n >= 50 && n <= 110) { driftActual = n; break; }
              }
            }
          } catch (e) {
            console.error("drift check failed", e);
          }

          if (controllerOffline) {
            errors.push({ home: homeName, error: `🔌 Controller OFFLINE — pool may not match target ${decision.temp}°F` });
            await supabase.from("home_pool_state").upsert({
              home_id: home.id,
              current_mode: decision.mode,
              current_target_temp: state.current_target_temp,
              last_synced_at: state.last_synced_at,
              last_occupancy_check: nowIso,
              next_checkin_date: decision.nextCheckin ? decision.nextCheckin.slice(0, 10) : null,
              notes: `${decision.reason} 🔌 controller offline`,
            }, { onConflict: "home_id" });
            continue;
          }

          if (driftActual !== null && driftActual !== decision.temp) {
            // Drift detected — reapply and alert
            const reapply = await fetch(`${supabaseUrl}/functions/v1/iaqualink-control`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
              body: JSON.stringify({ action: "set-temp", home_id: home.id, temp: decision.temp }),
            });
            const rJson = await reapply.json();
            const newActual = typeof rJson.actual_temp === "number" ? rJson.actual_temp : driftActual;
            await supabase.from("home_pool_state").upsert({
              home_id: home.id,
              current_mode: decision.mode,
              current_target_temp: newActual,
              last_synced_at: nowIso,
              last_occupancy_check: nowIso,
              next_checkin_date: decision.nextCheckin ? decision.nextCheckin.slice(0, 10) : null,
              notes: rJson.verified
                ? `${decision.reason} (drift corrected from ${driftActual}°F)`
                : `${decision.reason} ⚠️ drift ${driftActual}°F, reapply unverified`,
            }, { onConflict: "home_id" });
            changes.push({
              home: homeName,
              from: `drift ${driftActual}°F`,
              to: decision.mode,
              temp: newActual,
              reason: `drift corrected (was ${driftActual}, target ${decision.temp})`,
            });
          } else {
            await supabase.from("home_pool_state").upsert({
              home_id: home.id,
              current_mode: decision.mode,
              current_target_temp: driftActual ?? decision.temp,
              last_synced_at: driftActual !== null ? nowIso : state.last_synced_at,
              last_occupancy_check: nowIso,
              next_checkin_date: decision.nextCheckin ? decision.nextCheckin.slice(0, 10) : null,
            }, { onConflict: "home_id" });
          }
          continue;
        }

        // Apply change via iaqualink-control
        const resp = await fetch(`${supabaseUrl}/functions/v1/iaqualink-control`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({ action: "set-temp", home_id: home.id, temp: decision.temp }),
        });
        const result = await resp.json();
        if (!resp.ok || !result.success) {
          errors.push({ home: homeName, error: result.error || `HTTP ${resp.status}` });
          continue;
        }

        // Use verified actual temp if available; flag mismatch
        const actualTemp = typeof result.actual_temp === "number" ? result.actual_temp : decision.temp;
        const verified = result.verified === true;
        if (!verified) {
          errors.push({
            home: homeName,
            error: `Set ${decision.temp}°F but pool reads ${result.actual_temp ?? "unknown"}°F (not verified)`,
          });
        }

        await supabase
          .from("home_pool_state")
          .upsert({
            home_id: home.id,
            current_mode: decision.mode,
            current_target_temp: actualTemp,
            last_synced_at: nowIso,
            last_occupancy_check: nowIso,
            next_checkin_date: decision.nextCheckin ? decision.nextCheckin.slice(0, 10) : null,
            notes: verified ? decision.reason : `${decision.reason} ⚠️ unverified`,
          }, { onConflict: "home_id" });

        changes.push({
          home: homeName,
          from: state?.current_mode || null,
          to: decision.mode,
          temp: actualTemp,
          reason: verified ? decision.reason : `${decision.reason} (target ${decision.temp}, actual ${actualTemp})`,
        });
      } catch (e: any) {
        errors.push({ home: home.internal_name || home.name, error: e.message });
      }
    }

    // Send summary notification if changes
    if (changes.length > 0 || errors.length > 0) {
      const { data: settings } = await supabase.from("settings").select("*").single();
      const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");

      const summaryLines: string[] = [];
      for (const c of changes) {
        summaryLines.push(`• ${c.home}: ${c.from || "—"} → ${c.to} (${c.temp}°F) [${c.reason}]`);
      }
      for (const e of errors) {
        summaryLines.push(`⚠️ ${e.home}: ${e.error}`);
      }
      const summary = summaryLines.join("\n");

      // SMS
      const TWILIO_API_KEY = Deno.env.get("TWILIO_API_KEY");
      if (settings?.admin_sms_number && settings?.twilio_from_number && LOVABLE_API_KEY && TWILIO_API_KEY) {
        try {
          await fetch("https://connector-gateway.lovable.dev/twilio/Messages.json", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${LOVABLE_API_KEY}`,
              "X-Connection-Api-Key": TWILIO_API_KEY,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              To: settings.admin_sms_number,
              From: settings.twilio_from_number,
              Body: `🌡️ Pool Eco Sync\n${summary}`,
            }),
          });
        } catch (e) {
          console.error("SMS failed", e);
        }
      }

      // Email
      const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
      const recipient = settings?.admin_calendar_email || settings?.admin_email;
      if (recipient && LOVABLE_API_KEY && RESEND_API_KEY) {
        try {
          const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
            <h2>🌡️ Pool Eco Sync</h2>
            <pre style="background:#f8f9fa;padding:16px;border-radius:8px;white-space:pre-wrap;">${summary}</pre>
          </div>`;
          await fetch("https://connector-gateway.lovable.dev/resend/emails", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${LOVABLE_API_KEY}`,
              "X-Connection-Api-Key": RESEND_API_KEY,
            },
            body: JSON.stringify({
              from: "Pool Heat <noreply@ocadventurehomes.com>",
              to: [recipient],
              subject: `🌡️ Pool Eco Sync (${changes.length} change${changes.length !== 1 ? "s" : ""})`,
              html,
            }),
          });
        } catch (e) {
          console.error("Email failed", e);
        }
      }
    }

    return new Response(
      JSON.stringify({ success: true, changes, errors, processed: (homes || []).length }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e: any) {
    console.error("sync-pool-occupancy error:", e);
    return new Response(JSON.stringify({ error: e.message || String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
