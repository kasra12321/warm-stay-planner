import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Pacific timezone offset helper
function toPacificISO(dateStr: string, hour: number, minute: number): string {
  // Create a date in Pacific time, then convert to UTC for storage
  const dt = new Date(`${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`);
  // We need to figure out the UTC equivalent of this Pacific time
  // Use a trick: format in Pacific, parse back
  const pacificStr = `${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00-07:00`;
  // Note: PDT is -07:00, PST is -08:00. For simplicity, we'll compute dynamically.
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  // Build a reference date in Pacific
  const refDate = new Date(`${dateStr}T12:00:00Z`);
  const parts = formatter.formatToParts(refDate);
  // Get the offset by comparing
  const pacificNoon = new Date(`${dateStr}T12:00:00Z`);
  const pacificNoonStr = pacificNoon.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
  const pacificNoonDate = new Date(pacificNoonStr + ' UTC');
  const offsetMs = pacificNoon.getTime() - pacificNoonDate.getTime();
  
  // Target time in UTC
  const targetLocal = new Date(`${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  const targetUTC = new Date(targetLocal.getTime() + offsetMs);
  return targetUTC.toISOString();
}

function getNowPacific(): { dateStr: string; hour: number } {
  const now = new Date();
  const pacificStr = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
  const pacificDate = new Date(pacificStr);
  const year = pacificDate.getFullYear();
  const month = String(pacificDate.getMonth() + 1).padStart(2, '0');
  const day = String(pacificDate.getDate()).padStart(2, '0');
  return { dateStr: `${year}-${month}-${day}`, hour: pacificDate.getHours() };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { orderId } = await req.json();
    if (!orderId) throw new Error("orderId required");

    // Get order with dates and home
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select("*, order_dates(*), homes(name, internal_name, iaqualink_enabled, iaqualink_baseline_temp)")
      .eq("id", orderId)
      .single();

    if (orderErr || !order) throw new Error("Order not found");

    const dates = (order.order_dates as any[]).sort((a: any, b: any) => a.date.localeCompare(b.date));
    const homeNode = order.homes as any;
    const homeName = homeNode.internal_name || homeNode.name;
    const isIAqua = !!homeNode.iaqualink_enabled;
    const baselineTemp = homeNode.iaqualink_baseline_temp ?? 80;
    const turnOffMessage = isIAqua
      ? `Set pool back to ${baselineTemp}°F at ${homeName}`
      : `Turn off pool heat at ${homeName}`;
    const { dateStr: todayStr, hour: currentHour } = getNowPacific();

    // Find contiguous blocks
    const blocks: any[][] = [];
    let currentBlock: any[] = [];

    for (const d of dates) {
      if (currentBlock.length === 0) {
        currentBlock.push(d);
      } else {
        const lastDate = new Date(currentBlock[currentBlock.length - 1].date + 'T12:00:00Z');
        const thisDate = new Date(d.date + 'T12:00:00Z');
        const diffDays = (thisDate.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24);
        if (diffDays === 1) {
          currentBlock.push(d);
        } else {
          blocks.push(currentBlock);
          currentBlock = [d];
        }
      }
    }
    if (currentBlock.length > 0) blocks.push(currentBlock);

    const reminders: any[] = [];

    for (const block of blocks) {
      const firstDate = block[0];
      const lastDate = block[block.length - 1];

      // Turn ON at first date 8 AM and 9 AM
      const isToday8 = firstDate.date === todayStr && currentHour >= 8;
      const isToday9 = firstDate.date === todayStr && currentHour >= 9;

      if (isToday8) {
        // Send immediately for the turn-on
        reminders.push({
          order_id: orderId,
          home_id: order.home_id,
          scheduled_at: new Date().toISOString(),
          action_type: "turn_on",
          target_temperature: firstDate.temperature,
          message: `Turn on pool heat to ${firstDate.temperature}° at ${homeName}`,
          sent: false,
        });
        // If before 9 AM, don't add the 9 AM one
        if (!isToday9) {
          // Skip 9 AM since immediate was sent
        }
      } else {
        reminders.push({
          order_id: orderId,
          home_id: order.home_id,
          scheduled_at: toPacificISO(firstDate.date, 8, 0),
          action_type: "turn_on",
          target_temperature: firstDate.temperature,
          message: `Turn on pool heat to ${firstDate.temperature}° at ${homeName}`,
          sent: false,
        });
        reminders.push({
          order_id: orderId,
          home_id: order.home_id,
          scheduled_at: toPacificISO(firstDate.date, 9, 0),
          action_type: "turn_on",
          target_temperature: firstDate.temperature,
          message: `Turn on pool heat to ${firstDate.temperature}° at ${homeName}`,
          sent: false,
        });
      }

      // Temperature changes within the block
      for (let i = 1; i < block.length; i++) {
        if (block[i].temperature !== block[i - 1].temperature) {
          const changeDate = block[i].date;
          const isChangToday8 = changeDate === todayStr && currentHour >= 8;
          const isChangToday9 = changeDate === todayStr && currentHour >= 9;

          if (isChangToday8) {
            reminders.push({
              order_id: orderId,
              home_id: order.home_id,
              scheduled_at: new Date().toISOString(),
              action_type: "change",
              target_temperature: block[i].temperature,
              message: `Change pool heat to ${block[i].temperature}° at ${homeName}`,
              sent: false,
            });
          } else {
            reminders.push({
              order_id: orderId,
              home_id: order.home_id,
              scheduled_at: toPacificISO(changeDate, 8, 0),
              action_type: "change",
              target_temperature: block[i].temperature,
              message: `Change pool heat to ${block[i].temperature}° at ${homeName}`,
              sent: false,
            });
            reminders.push({
              order_id: orderId,
              home_id: order.home_id,
              scheduled_at: toPacificISO(changeDate, 9, 0),
              action_type: "change",
              target_temperature: block[i].temperature,
              message: `Change pool heat to ${block[i].temperature}° at ${homeName}`,
              sent: false,
            });
          }
        }
      }

      // Turn OFF at last date 4 PM and 5 PM
      reminders.push({
        order_id: orderId,
        home_id: order.home_id,
        scheduled_at: toPacificISO(lastDate.date, 16, 0),
        action_type: "turn_off",
        target_temperature: null,
        message: turnOffMessage,
        sent: false,
      });
      reminders.push({
        order_id: orderId,
        home_id: order.home_id,
        scheduled_at: toPacificISO(lastDate.date, 17, 0),
        action_type: "turn_off",
        target_temperature: null,
        message: turnOffMessage,
        sent: false,
});

function generateBookingICS(orderId: string, homeName: string, firstDate: string, lastDate: string, temps: string): string {
  // Event spans from 8 AM on first date to 5 PM on last date (Pacific)
  const formatICSDate = (dateStr: string, hour: number) => {
    const d = `${dateStr.replace(/-/g, '')}T${String(hour).padStart(2, '0')}0000`;
    return d;
  };

  const uid = `booking-${orderId}@poolheat`;

  return `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Pool Heat Checkout//EN
METHOD:REQUEST
BEGIN:VEVENT
UID:${uid}
DTSTART;TZID=America/Los_Angeles:${formatICSDate(firstDate, 8)}
DTEND;TZID=America/Los_Angeles:${formatICSDate(lastDate, 17)}
SUMMARY:🔥 Pool Heat: ${homeName} (${temps})
DESCRIPTION:Pool heating booked for ${homeName} from ${firstDate} to ${lastDate} at ${temps}. Order #${orderId.slice(0, 8)}
STATUS:CONFIRMED
BEGIN:VALARM
TRIGGER:-PT30M
ACTION:DISPLAY
DESCRIPTION:Pool heat starting soon at ${homeName}
END:VALARM
END:VEVENT
END:VCALENDAR`;
}
    }

    // Insert all reminders
    if (reminders.length > 0) {
      const { error: insertErr } = await supabase.from("reminders").insert(reminders);
      if (insertErr) throw insertErr;
    }

    // Send calendar invite email with .ics for the booking
    try {
      const { data: settings } = await supabase.from("settings").select("*").single();
      const recipientEmail = settings?.admin_calendar_email || settings?.admin_email;
      const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
      const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

      if (recipientEmail && LOVABLE_API_KEY && RESEND_API_KEY) {
        // Build a single calendar event spanning the full booking
        const allDates = dates.map((d: any) => d.date).sort();
        const firstDateStr = allDates[0];
        const lastDateStr = allDates[allDates.length - 1];
        const temps = [...new Set(dates.map((d: any) => d.temperature))].join("°/") + "°F";

        const icsContent = generateBookingICS(orderId, homeName, firstDateStr, lastDateStr, temps);
        const icsBase64 = btoa(icsContent);

        const emailHtml = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #1a1a2e;">🔥 New Pool Heat Booking</h2>
            <div style="background: #f8f9fa; border-radius: 8px; padding: 20px; margin: 16px 0;">
              <p style="margin: 0 0 8px; font-size: 16px;"><strong>${homeName}</strong></p>
              <p style="margin: 0 0 4px; color: #666;">Guest: ${order.guest_name}</p>
              <p style="margin: 0 0 4px; color: #666;">Dates: ${firstDateStr} to ${lastDateStr} (${allDates.length} day${allDates.length > 1 ? 's' : ''})</p>
              <p style="margin: 0 0 4px; color: #666;">Temperature: ${temps}</p>
              <p style="margin: 0; color: #666;">Total: $${order.total}</p>
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
            subject: `🔥 New Booking: ${homeName} — ${firstDateStr} to ${lastDateStr}`,
            html: emailHtml,
            attachments: [
              {
                filename: "booking.ics",
                content: icsBase64,
                content_type: "text/calendar",
              },
            ],
          }),
        });

        if (!emailResponse.ok) {
          console.error("Booking calendar email failed:", await emailResponse.text());
        } else {
          console.log(`Booking calendar invite sent to ${recipientEmail}`);
        }
      }
    } catch (e) {
      console.error("Calendar invite email error:", e);
    }

    // Send admin SMS notification
    try {
      const { data: smsSettings } = await supabase.from("settings").select("*").single();
      const adminPhone = smsSettings?.admin_sms_number;
      const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
      const TWILIO_API_KEY = Deno.env.get("TWILIO_API_KEY");

      if (adminPhone && LOVABLE_API_KEY && TWILIO_API_KEY && smsSettings?.twilio_from_number) {
        const allDates = dates.map((d: any) => d.date).sort();
        const firstDateStr = allDates[0];
        const lastDateStr = allDates[allDates.length - 1];
        const dateRange = allDates.length === 1 ? firstDateStr : `${firstDateStr} to ${lastDateStr}`;
        const temps = [...new Set(dates.map((d: any) => d.temperature))].join("°/") + "°F";

        const smsBody = `🔥 New Pool Heat Order!\n${homeName}\nGuest: ${order.guest_name}\nDates: ${dateRange} (${allDates.length} day${allDates.length > 1 ? 's' : ''})\nTemp: ${temps}\nTotal: $${order.total}\nPayment: ${order.payment_method}`;

        const GATEWAY_URL = "https://connector-gateway.lovable.dev/twilio";
        const smsResponse = await fetch(`${GATEWAY_URL}/Messages.json`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${LOVABLE_API_KEY}`,
            "X-Connection-Api-Key": TWILIO_API_KEY,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            To: adminPhone,
            From: smsSettings.twilio_from_number,
            Body: smsBody,
          }),
        });

        if (!smsResponse.ok) {
          console.error("Admin SMS failed:", await smsResponse.text());
        } else {
          console.log(`Admin SMS sent to ${adminPhone}`);
        }
      }
    } catch (e) {
      console.error("Admin SMS error:", e);
    }

    return new Response(JSON.stringify({ success: true, count: reminders.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("Error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
