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
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select("*, homes(name)")
      .eq("id", orderId)
      .single();

    if (orderErr || !order) throw new Error("Order not found");

    const { data: settings } = await supabase.from("settings").select("*").single();

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const TWILIO_API_KEY = Deno.env.get("TWILIO_API_KEY");

    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");
    if (!TWILIO_API_KEY) throw new Error("TWILIO_API_KEY not configured");
    if (!settings?.twilio_from_number) throw new Error("Twilio From number not configured in settings");
    if (!order.guest_mobile) throw new Error("No guest mobile number");

    const homeName = (order.homes as any)?.name || "your rental";
    const paymentNote = order.payment_method === "venmo" ? "via Venmo" : "via Zelle";
    const body = `Pool Heat Checkout: Your pool heating at ${homeName} has been submitted ${paymentNote}. Total: $${order.total}. Order #${orderId.slice(0, 8)}`;

    const GATEWAY_URL = "https://connector-gateway.lovable.dev/twilio";
    const response = await fetch(`${GATEWAY_URL}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "X-Connection-Api-Key": TWILIO_API_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        To: order.guest_mobile,
        From: settings.twilio_from_number,
        Body: body,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Twilio API error [${response.status}]: ${JSON.stringify(data)}`);
    }

    // Also notify admin if configured
    if (settings?.admin_sms_number) {
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
          Body: `New order from ${order.guest_name} at ${homeName} ${paymentNote}. Total: $${order.total}. Order #${orderId.slice(0, 8)}`,
        }),
      });
    }

    return new Response(JSON.stringify({ success: true, sid: data.sid }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("SMS Error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
