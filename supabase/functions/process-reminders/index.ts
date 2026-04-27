import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: settings } = await supabase.from("settings").select("*").single();

    const now = new Date().toISOString();
    const { data: dueReminders, error: fetchErr } = await supabase
      .from("reminders")
      .select("*, homes(name, internal_name, iaqualink_enabled, iaqualink_serial, iaqualink_baseline_temp, controller_type, screenlogic_system_name)")
      .eq("sent", false)
      .lte("scheduled_at", now)
      .order("scheduled_at")
      .limit(50);

    if (fetchErr) throw fetchErr;
    if (!dueReminders || dueReminders.length === 0) {
      return new Response(JSON.stringify({ processed: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let processed = 0;

    for (const reminder of dueReminders) {
      try {
        const home = reminder.homes as any;
        const homeName = home?.internal_name || home?.name || "Property";

        // Attempt iAquaLink auto-execution if enabled and serial set
        let autoExecuted = false;
        let autoResult: string | null = null;
        let autoStatusLine = "";

        // Auto-execute via whichever controller this home is configured for.
        // `iaqualink_enabled` doubles as the "auto-control enabled" flag for both
        // controllers; the controller_type column picks which edge function to call.
        const controllerType = home?.controller_type || "iaqualink";
        const controlFn =
          controllerType === "screenlogic" ? "screenlogic-control" : "iaqualink-control";
        const hasController =
          controllerType === "screenlogic"
            ? !!home?.screenlogic_system_name
            : !!home?.iaqualink_serial;

        if (home?.iaqualink_enabled && hasController) {
          let targetTemp: number | null = null;
          if (reminder.action_type === "turn_on" || reminder.action_type === "change") {
            targetTemp = reminder.target_temperature;
          } else if (reminder.action_type === "turn_off") {
            targetTemp = home.iaqualink_baseline_temp ?? 80;
          }

          if (targetTemp !== null) {
            try {
              const resp = await fetch(`${supabaseUrl}/functions/v1/${controlFn}`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${supabaseKey}`,
                },
                body: JSON.stringify({
                  action: "set-temp",
                  home_id: reminder.home_id,
                  temp: targetTemp,
                }),
              });
              const data = await resp.json();
              if (resp.ok && data.success) {
                autoExecuted = true;
                autoResult = `Set to ${targetTemp}°F`;
                autoStatusLine = `\n\n✅ Auto-set to ${targetTemp}°F`;
              } else {
                autoResult = `Failed: ${data.error || "unknown"}`;
                autoStatusLine = `\n\n⚠️ Auto-set FAILED: ${data.error || "unknown"}`;
              }
            } catch (e: any) {
              autoResult = `Error: ${e.message}`;
              autoStatusLine = `\n\n⚠️ Auto-set ERROR: ${e.message}`;
            }
          }
        }

        const augmentedMessage = reminder.message + autoStatusLine;

        // Send SMS via Twilio connector if configured
        if (settings?.admin_sms_number && settings?.twilio_from_number) {
          const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
          const TWILIO_API_KEY = Deno.env.get("TWILIO_API_KEY");

          if (LOVABLE_API_KEY && TWILIO_API_KEY) {
            const GATEWAY_URL = "https://connector-gateway.lovable.dev/twilio";
            await fetch(`${GATEWAY_URL}/Messages.json`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${LOVABLE_API_KEY}`,
                "X-Connection-Api-Key": TWILIO_API_KEY,
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: new URLSearchParams({
                To: settings.admin_sms_number,
                From: settings.twilio_from_number,
                Body: augmentedMessage,
              }),
            });
          }
        }

        // Send reminder email via Resend
        if (settings?.admin_email || settings?.admin_calendar_email) {
          const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
          const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

          if (LOVABLE_API_KEY && RESEND_API_KEY) {
            const recipientEmail = settings.admin_calendar_email || settings.admin_email;

            const autoBadge = autoExecuted
              ? `<div style="background:#d4edda;color:#155724;padding:10px;border-radius:6px;margin:12px 0;">✅ <strong>Auto-set to ${reminder.action_type === "turn_off" ? (home.iaqualink_baseline_temp ?? 80) : reminder.target_temperature}°F</strong> via iAquaLink</div>`
              : autoResult
              ? `<div style="background:#f8d7da;color:#721c24;padding:10px;border-radius:6px;margin:12px 0;">⚠️ <strong>Auto-set failed:</strong> ${autoResult}</div>`
              : "";

            const emailHtml = `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #1a1a2e;">🔥 Pool Heat Reminder</h2>
                <div style="background: #f8f9fa; border-radius: 8px; padding: 20px; margin: 16px 0;">
                  <p style="margin: 0 0 8px; font-size: 16px;"><strong>${reminder.message}</strong></p>
                  <p style="margin: 0; color: #666;">Home: ${homeName}</p>
                  ${reminder.target_temperature ? `<p style="margin: 4px 0 0; color: #666;">Temperature: ${reminder.target_temperature}°F</p>` : ''}
                </div>
                ${autoBadge}
              </div>
            `;

            const GATEWAY_URL = "https://connector-gateway.lovable.dev/resend";
            const emailResponse = await fetch(`${GATEWAY_URL}/emails`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${LOVABLE_API_KEY}`,
                "X-Connection-Api-Key": RESEND_API_KEY,
              },
              body: JSON.stringify({
                from: "Pool Heat <noreply@ocadventurehomes.com>",
                to: [recipientEmail],
                subject: `🔥 ${reminder.message}${autoExecuted ? " (auto-set ✅)" : autoResult ? " (auto-set ⚠️)" : ""}`,
                html: emailHtml,
              }),
            });

            if (!emailResponse.ok) {
              console.error("Resend email failed:", await emailResponse.text());
            } else {
              console.log(`Email sent to ${recipientEmail}`);
            }
          }
        }

        // Mark as sent + record auto-exec result
        await supabase
          .from("reminders")
          .update({
            sent: true,
            sent_at: new Date().toISOString(),
            auto_executed: autoExecuted,
            auto_execution_result: autoResult,
          })
          .eq("id", reminder.id);

        // Update home_pool_state so eco sync knows what mode we're in
        if (autoExecuted && reminder.home_id) {
          const isGuestHeat = reminder.action_type === "turn_on" || reminder.action_type === "change";
          const appliedTemp =
            reminder.action_type === "turn_off"
              ? home.iaqualink_baseline_temp ?? 80
              : reminder.target_temperature;
          await supabase.from("home_pool_state").upsert(
            {
              home_id: reminder.home_id,
              current_mode: isGuestHeat ? "guest_heat" : "baseline",
              current_target_temp: appliedTemp,
              last_synced_at: new Date().toISOString(),
              notes: `reminder: ${reminder.action_type}`,
            },
            { onConflict: "home_id" },
          );
        }

        processed++;
      } catch (e) {
        console.error(`Failed to process reminder ${reminder.id}:`, e);
      }
    }

    return new Response(JSON.stringify({ processed }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("Error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
