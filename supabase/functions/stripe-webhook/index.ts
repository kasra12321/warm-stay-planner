import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";

serve(async (req) => {
  try {
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
    if (!stripeKey || !webhookSecret) throw new Error("Stripe not configured");

    const stripe = new Stripe(stripeKey, { apiVersion: "2023-10-16" });
    const body = await req.text();
    const sig = req.headers.get("stripe-signature");
    if (!sig) throw new Error("No signature");

    const event = await stripe.webhooks.constructEventAsync(body, sig, webhookSecret);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const orderId = session.metadata?.order_id;
      if (!orderId) throw new Error("No order_id in metadata");

      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const supabase = createClient(supabaseUrl, serviceKey);

      // Get order to verify it exists and is pending
      const { data: order, error: orderErr } = await supabase
        .from("orders")
        .select("*, order_dates(*)")
        .eq("id", orderId)
        .single();

      if (orderErr || !order) throw new Error("Order not found");
      if (order.status !== "stripe_pending") {
        // Already processed or failed
        return new Response(JSON.stringify({ received: true }), { status: 200 });
      }

      // Final blocked date check to prevent double-booking
      const { data: blocked } = await supabase.rpc("get_blocked_dates", { p_home_id: order.home_id });
      const blockedSet = new Set((blocked || []).map((b: any) => b.date));
      const orderDates = order.order_dates as any[];

      for (const od of orderDates) {
        if (blockedSet.has(od.date)) {
          // Date was taken — mark order as failed, refund
          await supabase.from("orders").update({ status: "stripe_failed" }).eq("id", orderId);
          // Attempt refund
          if (session.payment_intent) {
            try {
              await stripe.refunds.create({ payment_intent: session.payment_intent as string });
            } catch (e) {
              console.error("Refund failed:", e);
            }
          }
          return new Response(JSON.stringify({ received: true, refunded: true }), { status: 200 });
        }
      }

      // Mark order as paid
      await supabase.from("orders").update({ status: "stripe_paid" }).eq("id", orderId);

      // Create reminders
      try {
        await supabase.functions.invoke("create-reminders", {
          body: { orderId },
        });
      } catch (e) {
        console.error("Reminder creation error:", e);
      }

      // Notify admin (SMS + email)
      try {
        await supabase.functions.invoke("notify-admin-order", {
          body: { orderId },
        });
      } catch (e) {
        console.error("Admin notify error:", e);
      }

      // Send guest SMS confirmation via Twilio connector
      try {
        const { data: settings } = await supabase.from("settings").select("*").single();
        const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
        const TWILIO_API_KEY = Deno.env.get("TWILIO_API_KEY");

        if (LOVABLE_API_KEY && TWILIO_API_KEY && settings?.twilio_from_number && order.guest_mobile) {
          const GATEWAY_URL = "https://connector-gateway.lovable.dev/twilio";
          const response = await fetch(`${GATEWAY_URL}/Messages.json`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${LOVABLE_API_KEY}`,
              "X-Connection-Api-Key": TWILIO_API_KEY,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              To: order.guest_mobile,
              From: settings.twilio_from_number,
              Body: `Pool Heat Checkout: Payment confirmed! Your pool heating is scheduled. Order #${orderId.slice(0, 8)}`,
            }),
          });
          if (!response.ok) {
            console.error("SMS send failed:", await response.text());
          }
        }
      } catch (e) {
        console.error("SMS error:", e);
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("Webhook error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
});
