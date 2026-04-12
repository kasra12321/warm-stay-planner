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

    // Get settings
    const { data: settings } = await supabase.from("settings").select("*").single();

    // Get unsent reminders that are due
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

        // Send email if configured
        if (settings?.admin_email) {
          // Generate ICS content
          const icsContent = generateICS(reminder);
          
          // For now, log the email (email sending via SMTP would need a connector)
          console.log(`Email to ${settings.admin_email}: ${reminder.message}`);
          
          // Send calendar invite if configured
          if (settings?.admin_calendar_email) {
            console.log(`Calendar invite to ${settings.admin_calendar_email}`);
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
  const endDate = new Date(startDate.getTime() + 30 * 60 * 1000); // 30 min duration
  
  const formatICSDate = (d: Date) =>
    d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  return `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Pool Heat Checkout//EN
BEGIN:VEVENT
DTSTART:${formatICSDate(startDate)}
DTEND:${formatICSDate(endDate)}
SUMMARY:${reminder.message}
DESCRIPTION:${reminder.message}
END:VEVENT
END:VCALENDAR`;
}
