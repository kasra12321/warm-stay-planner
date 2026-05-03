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
  const otaReservations: Reservation[] = (data.data || [])
    .filter((res: any) => res.status === "accepted")
    .map((res: any) => ({
      check_in: res.check_in,
      check_out: res.check_out,
      status: res.status,
    }));

  // The /v2/reservations endpoint does NOT include direct/manual bookings (HOST-*).
  // Pull the calendar to capture ALL blocked days regardless of source (direct, OTA, owner stay, manual block),
  // then synthesize Reservation entries for any contiguous RESERVED/UNAVAILABLE range not already covered.
  try {
    const calUrl = `https://public.api.hospitable.com/v2/properties/${encodeURIComponent(
      propertyId,
    )}/calendar?start_date=${start}&end_date=${end}`;
    const cr = await fetch(calUrl, {
      headers: { Authorization: `Bearer ${pat}`, Accept: "application/json" },
    });
    if (cr.ok) {
      const cdata = await cr.json();
      const days: Array<{ date: string; status?: { available?: boolean; reason?: string } }> =
        cdata?.data?.days || [];
      // Only treat days that are blocked because of an actual reservation
      // (direct/manual booking, owner stay, or OTA reservation imported via
      // Hospitable's calendar) as "occupied". Hospitable's calendar also
      // marks days unavailable for non-guest reasons — `ADVANCED_NOTICE`
      // (lead-time buffer Airbnb adds before today), `USER` (manual block
      // the host placed on the calendar), `MIN_STAY`, etc. Treating those
      // as occupied incorrectly forces baseline heat on an empty house.
      const reservationReasons = new Set(["RESERVATION", "RESERVED", "BOOKED", "OWNER_STAY"]);
      const blocked = new Set(
        days
          .filter((d) => {
            if (!d?.status || d.status.available !== false) return false;
            const reason = String((d.status as any).reason || "").toUpperCase();
            const sourceType = String((d.status as any).source_type || "").toUpperCase();
            // Accept either an explicit reservation-style reason, or a
            // RESERVATION source_type whose reason isn't AVAILABLE (covers
            // direct bookings that Hospitable doesn't always label).
            return reservationReasons.has(reason) || (sourceType === "RESERVATION" && reason !== "AVAILABLE");
          })
          .map((d) => d.date),
      );

      // Determine which blocked days are NOT already covered by an OTA reservation.
      // (OTA reservations cover [check_in date .. check_out date - 1].)
      const otaCoveredDays = new Set<string>();
      for (const r of otaReservations) {
        const ci = new Date(r.check_in);
        const co = new Date(r.check_out);
        const cur = new Date(Date.UTC(ci.getUTCFullYear(), ci.getUTCMonth(), ci.getUTCDate()));
        const last = new Date(Date.UTC(co.getUTCFullYear(), co.getUTCMonth(), co.getUTCDate()));
        while (cur < last) {
          otaCoveredDays.add(cur.toISOString().slice(0, 10));
          cur.setUTCDate(cur.getUTCDate() + 1);
        }
      }

      const uncovered = [...blocked].filter((d) => !otaCoveredDays.has(d)).sort();

      // Group contiguous uncovered dates into ranges and synthesize a reservation per range.
      // Use 4pm local (assume UTC-7 PT) → 23:00 UTC check-in, 11am local → 18:00 UTC checkout
      // for a closer match to typical Hospitable check-in times.
      const ranges: Array<{ start: string; endExclusive: string }> = [];
      for (const date of uncovered) {
        const last = ranges[ranges.length - 1];
        const nextDate = new Date(date + "T00:00:00Z");
        nextDate.setUTCDate(nextDate.getUTCDate() + 1);
        const nextStr = nextDate.toISOString().slice(0, 10);
        if (last && last.endExclusive === date) {
          last.endExclusive = nextStr;
        } else {
          ranges.push({ start: date, endExclusive: nextStr });
        }
      }

      for (const range of ranges) {
        otaReservations.push({
          check_in: `${range.start}T23:00:00Z`,
          check_out: `${range.endExclusive}T18:00:00Z`,
          status: "accepted",
        });
      }
    } else {
      console.warn(`Calendar fetch failed for ${propertyId}: ${cr.status}`);
    }
  } catch (e) {
    console.error(`Calendar fetch error for ${propertyId}:`, e);
  }

  return otaReservations;
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

function getPacificDateString(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
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
      .select("id, name, internal_name, iaqualink_serial, controller_enabled, baseline_temp, hospitable_property_id, eco_mode_enabled, eco_temp, controller_type, screenlogic_system_name")
      .eq("controller_enabled", true)
      .not("hospitable_property_id", "is", null);
    if (error) throw error;

    const nowIso = new Date().toISOString();
    const changes: Array<{ home: string; from: string | null; to: string; temp: number; reason: string }> = [];
    const errors: Array<{ home: string; error: string }> = [];

    // Stagger calls between homes so we don't hammer the Pi (which bridges all
    // ScreenLogic homes through a single TCP connection per pool). 20s gap is
    // enough breathing room without making the whole sync run too long.
    const STAGGER_MS = 20_000;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const homesList = homes || [];
    for (let i = 0; i < homesList.length; i++) {
      const home = homesList[i];
      if (i > 0) await sleep(STAGGER_MS);
      try {
        // Dispatch the right controller. iAquaLink homes still need a serial;
        // ScreenLogic homes need a system name. Skip homes that have neither so
        // the sync only acts on fully-configured properties.
        const controllerType = (home as any).controller_type || "iaqualink";
        const controlFn = controllerType === "screenlogic" ? "screenlogic-control" : "iaqualink-control";
        if (controllerType === "iaqualink" && !home.iaqualink_serial) continue;
        if (controllerType === "screenlogic" && !(home as any).screenlogic_system_name) continue;

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
        const baseline = home.baseline_temp ?? 80;
        const ecoTemp = home.eco_mode_enabled ? (home.eco_temp ?? 75) : baseline;
        let decision = decideTemp(reservations, nowIso, baseline, ecoTemp);

        const homeName = home.internal_name || home.name;
        const ecoPausedUntil = (state as any)?.eco_paused_until || null;
        const ecoPauseActive = decision.mode === "eco" && ecoPausedUntil && getPacificDateString() < ecoPausedUntil;
        if (ecoPauseActive) {
          decision = { ...decision, mode: "baseline", temp: baseline, reason: `eco paused until ${ecoPausedUntil}` };
        }
        const nextEcoPausedUntil = ecoPauseActive ? ecoPausedUntil : null;

        if (state?.current_target_temp === decision.temp && state?.current_mode === decision.mode) {
          // No decision change. Do a drift check: read the actual pool setpoint
          // and compare to what we think it is. Re-applies + alerts if drifted.
          let driftActual: number | null = null;
          let controllerOffline = false;
          try {
            const verify = await fetch(`${supabaseUrl}/functions/v1/${controlFn}`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
              body: JSON.stringify({ action: "get-status", home_id: home.id }),
            });
            const vJson = await verify.json();
            if (vJson?.success && vJson?.status) {
              if (vJson.status["status"] === "Offline" || vJson.status["response"] === "Error") {
                controllerOffline = true;
              }
              // Smart-match: if ANY setpoint field equals our target, we're in sync.
              // Otherwise report the first valid reading as the actual.
              const setpoints = [vJson.status["pool_set_point"], vJson.status["spa_set_point"]]
                .map((c) => parseInt(c, 10))
                .filter((n) => !isNaN(n) && n >= 50 && n <= 110);
              if (setpoints.includes(decision.temp)) {
                driftActual = decision.temp;
              } else if (setpoints.length > 0) {
                driftActual = setpoints[0];
              }
            }
          } catch (e) {
            console.error("drift check failed", e);
          }

          if (controllerOffline) {
            // No temperature change needed right now — silently record offline status
            // without alerting. We only alert on offline when we actually try to set a temp.
            await supabase.from("home_pool_state").upsert({
              home_id: home.id,
              current_mode: decision.mode,
              current_target_temp: state.current_target_temp,
              last_synced_at: state.last_synced_at,
              last_occupancy_check: nowIso,
              next_checkin_date: decision.nextCheckin ? decision.nextCheckin.slice(0, 10) : null,
              eco_paused_until: nextEcoPausedUntil,
              notes: `${decision.reason} 🔌 controller offline`,
            }, { onConflict: "home_id" });
            continue;
          }

          if (driftActual !== null && driftActual !== decision.temp) {
            // Drift detected — reapply and alert
            const reapply = await fetch(`${supabaseUrl}/functions/v1/${controlFn}`, {
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
              eco_paused_until: nextEcoPausedUntil,
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
              eco_paused_until: nextEcoPausedUntil,
              // Controller responded successfully this round — clear any stale
              // "🔌 controller offline" note from a previous failed drift check.
              notes: decision.reason,
            }, { onConflict: "home_id" });
          }
          continue;
        }

        // Apply change via iaqualink-control
        // Apply change via the home's configured controller
        const resp = await fetch(`${supabaseUrl}/functions/v1/${controlFn}`, {
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
          // Even on failure, record SOMETHING in home_pool_state so newly-added
          // homes don't appear blank in the admin view forever. Preserve any
          // previously-known target temp; mark the error in notes.
          await supabase.from("home_pool_state").upsert({
            home_id: home.id,
            current_mode: decision.mode,
            current_target_temp: state?.current_target_temp ?? null,
            last_synced_at: state?.last_synced_at ?? null,
            last_occupancy_check: nowIso,
            next_checkin_date: decision.nextCheckin ? decision.nextCheckin.slice(0, 10) : null,
            eco_paused_until: nextEcoPausedUntil,
            notes: `${decision.reason} ⚠️ ${result.error || `HTTP ${resp.status}`}`.slice(0, 500),
          }, { onConflict: "home_id" });
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
            eco_paused_until: nextEcoPausedUntil,
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

      // Email (SMS removed — email only)
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
