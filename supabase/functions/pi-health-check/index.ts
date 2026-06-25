import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * pi-health-check
 *
 * Pings the Raspberry Pi bridge `/healthz` endpoint and tracks state in
 * `pi_health_state`. Sends an admin email ONLY on transitions:
 *   - healthy → unhealthy (after 2 consecutive failures, to avoid flapping)
 *   - unhealthy → healthy (recovery notice)
 *
 * Scheduled via pg_cron every 5 minutes.
 */

const FAILURE_THRESHOLD = 2; // require 2 consecutive failures before alerting
const TIMEOUT_MS = 10_000;

// Module-scope cache for admin_email — invalidated every 10 minutes.
let SETTINGS_CACHE: { adminEmail: string; expires: number } | null = null;
async function getCachedAdminEmail(supabase: any): Promise<string> {
  if (SETTINGS_CACHE && SETTINGS_CACHE.expires > Date.now()) return SETTINGS_CACHE.adminEmail;
  const { data } = await supabase.from("settings").select("admin_email").single();
  const adminEmail = data?.admin_email || "kasrajafroodi@gmail.com";
  SETTINGS_CACHE = { adminEmail, expires: Date.now() + 10 * 60 * 1000 };
  return adminEmail;
}

async function sendAdminEmail(opts: {
  recipient: string;
  subject: string;
  html: string;
}) {
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  if (!LOVABLE_API_KEY || !RESEND_API_KEY) {
    console.error("[pi-health-check] Missing LOVABLE_API_KEY or RESEND_API_KEY");
    return false;
  }
  const r = await fetch("https://connector-gateway.lovable.dev/resend/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LOVABLE_API_KEY}`,
      "X-Connection-Api-Key": RESEND_API_KEY,
    },
    body: JSON.stringify({
      from: "Pool Heat <noreply@ocadventurehomes.com>",
      to: [opts.recipient],
      subject: opts.subject,
      html: opts.html,
    }),
  });
  if (!r.ok) {
    console.error("[pi-health-check] Email send failed:", await r.text());
    return false;
  }
  return true;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const piUrl = Deno.env.get("SCREENLOGIC_PI_URL");
    const supabase = createClient(supabaseUrl, serviceKey);

    if (!piUrl) {
      return new Response(JSON.stringify({ error: "SCREENLOGIC_PI_URL not set" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Probe /healthz (no auth required by design)
    let isHealthy = false;
    let errorMessage: string | null = null;
    try {
      const r = await fetch(`${piUrl.replace(/\/$/, "")}/healthz`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!r.ok) {
        errorMessage = `Pi responded HTTP ${r.status}`;
      } else {
        const json = await r.json().catch(() => null);
        if (json?.ok === true) {
          isHealthy = true;
        } else {
          errorMessage = `Pi /healthz returned unexpected body: ${JSON.stringify(json).slice(0, 200)}`;
        }
      }
    } catch (e: any) {
      errorMessage =
        e?.name === "TimeoutError" || e?.name === "AbortError"
          ? `Timed out after ${TIMEOUT_MS / 1000}s contacting Pi at ${piUrl}`
          : `Failed to reach Pi at ${piUrl}: ${e?.message || e}`;
    }

    // Load current state (single-row table)
    const { data: state } = await supabase
      .from("pi_health_state")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const prevStatus = state?.status || "unknown";
    const prevFailures = state?.consecutive_failures || 0;
    const newStatus = isHealthy ? "healthy" : "unhealthy";
    const newFailures = isHealthy ? 0 : prevFailures + 1;
    const now = new Date().toISOString();

    // Decide if we should alert
    const wentDown =
      !isHealthy &&
      newFailures >= FAILURE_THRESHOLD &&
      prevStatus !== "unhealthy";
    const recovered = isHealthy && prevStatus === "unhealthy";

    let alertSent = false;
    if (wentDown || recovered) {
      const recipient = await getCachedAdminEmail(supabase);
      const downSince = state?.last_status_change_at
        ? new Date(state.last_status_change_at).toLocaleString("en-US", { timeZone: "America/Los_Angeles" })
        : "unknown";

      if (wentDown) {
        alertSent = await sendAdminEmail({
          recipient,
          subject: "🚨 Pool Heat Pi Bridge is OFFLINE",
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #b91c1c;">🚨 Pi Bridge Offline</h2>
              <p>The Raspberry Pi bridge that controls your ScreenLogic pool heaters is not responding.</p>
              <div style="background: #fef2f2; border-left: 4px solid #b91c1c; border-radius: 4px; padding: 16px; margin: 16px 0;">
                <p style="margin: 0 0 8px;"><strong>URL:</strong> ${piUrl}</p>
                <p style="margin: 0 0 8px;"><strong>Consecutive failures:</strong> ${newFailures}</p>
                <p style="margin: 0 0 8px;"><strong>Last error:</strong> ${errorMessage || "unknown"}</p>
                <p style="margin: 0;"><strong>Detected at:</strong> ${new Date(now).toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} PT</p>
              </div>
              <p style="color: #444;"><strong>What to do:</strong> SSH into the Pi and run <code style="background:#f3f4f6;padding:2px 6px;border-radius:3px;">sudo systemctl restart poolheat</code>. If that doesn't work, reboot the Pi.</p>
              <p style="color: #666; font-size: 12px;">You'll get one more email when the Pi comes back online. We won't keep emailing you while it's down.</p>
            </div>`,
        });
      } else if (recovered) {
        alertSent = await sendAdminEmail({
          recipient,
          subject: "✅ Pool Heat Pi Bridge is back online",
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #15803d;">✅ Pi Bridge Recovered</h2>
              <p>The Raspberry Pi bridge is responding to health checks again.</p>
              <div style="background: #f0fdf4; border-left: 4px solid #15803d; border-radius: 4px; padding: 16px; margin: 16px 0;">
                <p style="margin: 0 0 8px;"><strong>Was down since:</strong> ${downSince} PT</p>
                <p style="margin: 0;"><strong>Recovered at:</strong> ${new Date(now).toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} PT</p>
              </div>
            </div>`,
        });
      }
    }

    // Persist updated state
    const statusChanged = prevStatus !== newStatus;
    // Skip the write entirely on a steady-state healthy check — nothing changed
    // and `last_checked_at` is informational. Cuts ~95% of pi_health_state writes.
    const errorChanged = (state?.last_error || null) !== (errorMessage || null);
    const shouldWrite = statusChanged || errorChanged || alertSent || !isHealthy;
    if (shouldWrite) {
      await supabase
        .from("pi_health_state")
        .update({
          status: newStatus,
          last_checked_at: now,
          last_status_change_at: statusChanged ? now : state?.last_status_change_at,
          last_error: errorMessage,
          consecutive_failures: newFailures,
          last_alert_sent_at: alertSent ? now : state?.last_alert_sent_at,
          updated_at: now,
        })
        .eq("id", state?.id);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        healthy: isHealthy,
        consecutive_failures: newFailures,
        alert_sent: alertSent,
        error: errorMessage,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e: any) {
    console.error("[pi-health-check] error:", e);
    return new Response(JSON.stringify({ error: e.message || String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});