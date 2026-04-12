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
      .select("*, order_dates(*), homes(name)")
      .eq("id", orderId)
      .single();

    if (orderErr || !order) throw new Error("Order not found");

    const dates = (order.order_dates as any[]).sort((a: any, b: any) => a.date.localeCompare(b.date));
    const homeName = (order.homes as any).name;
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
        message: `Turn off pool heat at ${homeName}`,
        sent: false,
      });
      reminders.push({
        order_id: orderId,
        home_id: order.home_id,
        scheduled_at: toPacificISO(lastDate.date, 17, 0),
        action_type: "turn_off",
        target_temperature: null,
        message: `Turn off pool heat at ${homeName}`,
        sent: false,
      });
    }

    // Insert all reminders
    if (reminders.length > 0) {
      const { error: insertErr } = await supabase.from("reminders").insert(reminders);
      if (insertErr) throw insertErr;
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
