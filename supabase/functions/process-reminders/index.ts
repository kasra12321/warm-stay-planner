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
      .select("*, homes(name)")
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
                Body: reminder.message,
              }),
            });
          }
        }

        // Send email with .ics calendar invite via Resend
        if (settings?.admin_email || settings?.admin_calendar_email) {
          const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
          const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

          if (LOVABLE_API_KEY && RESEND_API_KEY) {
            const recipientEmail = settings.admin_calendar_email || settings.admin_email;
            const icsContent = generateICS(reminder);
            const icsBase64 = btoa(icsContent);
            const homeName = (reminder.homes as any)?.name || "Property";

            const emailHtml = `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #1a1a2e;">🔥 Pool Heat Reminder</h2>
                <div style="background: #f8f9fa; border-radius: 8px; padding: 20px; margin: 16px 0;">
                  <p style="margin: 0 0 8px; font-size: 16px;"><strong>${reminder.message}</strong></p>
                  <p style="margin: 0; color: #666;">Home: ${homeName}</p>
                  ${reminder.target_temperature ? `<p style="margin: 4px 0 0; color: #666;">Temperature: ${reminder.target_temperature}°F</p>` : ''}
                </div>
                <p style="color: #999; font-size: 12px;">A calendar event is attached to this email.</p>
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
                subject: `🔥 ${reminder.message}`,
                html: emailHtml,
                attachments: [
                  {
                    filename: "reminder.ics",
                    content: icsBase64,
                    content_type: "text/calendar",
                  },
                ],
              }),
            });

            if (!emailResponse.ok) {
              console.error("Resend email failed:", await emailResponse.text());
            } else {
              console.log(`Email sent to ${recipientEmail}`);
            }
          }
        }

        // Mark as sent
        await supabase
          .from("reminders")
          .update({ sent: true, sent_at: new Date().toISOString() })
          .eq("id", reminder.id);

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

function generateICS(reminder: any): string {
  const startDate = new Date(reminder.scheduled_at);
  const endDate = new Date(startDate.getTime() + 30 * 60 * 1000);

  const formatICSDate = (d: Date) =>
    d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

  const uid = `${reminder.id}@poolheat`;

  return `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Pool Heat Checkout//EN
METHOD:REQUEST
BEGIN:VEVENT
UID:${uid}
DTSTART:${formatICSDate(startDate)}
DTEND:${formatICSDate(endDate)}
SUMMARY:${reminder.message}
DESCRIPTION:${reminder.message}
STATUS:CONFIRMED
BEGIN:VALARM
TRIGGER:-PT10M
ACTION:DISPLAY
DESCRIPTION:${reminder.message}
END:VALARM
END:VEVENT
END:VCALENDAR`;
}
