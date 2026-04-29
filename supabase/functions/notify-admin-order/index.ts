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
    const { orderId } = await req.json();
    if (!orderId) throw new Error("orderId required");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select("*, homes(name, internal_name), order_dates(*)")
      .eq("id", orderId)
      .single();

    if (orderErr || !order) throw new Error("Order not found");

    const { data: settings } = await supabase.from("settings").select("*").single();
    const home = order.homes as any;
    const homeName = home?.internal_name || home?.name || "Property";
    const dates = (order.order_dates as any[]).map((d) => d.date).sort();
    const firstDate = dates[0];
    const lastDate = dates[dates.length - 1];
    const dateRange = dates.length === 1 ? firstDate : `${firstDate} to ${lastDate}`;
    const temps = [...new Set((order.order_dates as any[]).map((d) => d.temperature))].join("°/") + "°F";

    const paymentLabel =
      order.payment_method === "apple_cash"
        ? "Apple Cash"
        : order.payment_method.charAt(0).toUpperCase() + order.payment_method.slice(1);

    const smsBody = `🔥 New Pool Heat Order!\n${homeName}\nGuest: ${order.guest_name} (${order.guest_mobile})\nDates: ${dateRange} (${dates.length} day${dates.length > 1 ? "s" : ""})\nTemp: ${temps}\nTotal: $${order.total}\nPayment: ${paymentLabel} (${order.status})`;

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

    // Admin SMS removed — email only.
    void smsBody;

    // Admin email via Resend
    const recipientEmail = settings?.admin_email || settings?.admin_calendar_email;
    if (recipientEmail && LOVABLE_API_KEY && RESEND_API_KEY) {
      try {
        const html = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #1a1a2e;">🔥 New Pool Heat Order</h2>
            <div style="background: #f8f9fa; border-radius: 8px; padding: 20px; margin: 16px 0;">
              <p style="margin: 0 0 8px; font-size: 16px;"><strong>${homeName}</strong></p>
              <p style="margin: 0 0 4px; color: #444;">Guest: ${order.guest_name} (${order.guest_mobile})</p>
              <p style="margin: 0 0 4px; color: #444;">Dates: ${dateRange} (${dates.length} day${dates.length > 1 ? "s" : ""})</p>
              <p style="margin: 0 0 4px; color: #444;">Temperature: ${temps}</p>
              <p style="margin: 0 0 4px; color: #444;">Total: $${order.total}</p>
              <p style="margin: 0; color: #444;">Payment: <strong>${paymentLabel}</strong> — ${order.status}</p>
            </div>
          </div>
        `;
        const r = await fetch("https://connector-gateway.lovable.dev/resend/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${LOVABLE_API_KEY}`,
            "X-Connection-Api-Key": RESEND_API_KEY,
          },
          body: JSON.stringify({
            from: "Pool Heat <noreply@ocadventurehomes.com>",
            to: [recipientEmail],
            subject: `🔥 New Order: ${homeName} — ${dateRange} ($${order.total} via ${paymentLabel})`,
            html,
          }),
        });
        if (!r.ok) console.error("Admin email failed:", await r.text());
      } catch (e) {
        console.error("Admin email error:", e);
      }
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("notify-admin-order error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});