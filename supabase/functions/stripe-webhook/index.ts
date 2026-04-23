import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";

serve(async (req) => {
  // Always return 200 except for invalid signatures, so Stripe doesn't disable the endpoint.
  let event: Stripe.Event;
  let stripe: Stripe;

  try {
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
    if (!stripeKey || !webhookSecret) {
      console.error("Stripe not configured (missing key or webhook secret)");
      return new Response(JSON.stringify({ ok: true, skipped: "not_configured" }), { status: 200 });
    }

    stripe = new Stripe(stripeKey, { apiVersion: "2023-10-16" });
    const body = await req.text();
    const sig = req.headers.get("stripe-signature");
    if (!sig) {
      // Missing signature is a real signature failure — return 400 so Stripe surfaces it.
      return new Response(JSON.stringify({ error: "No signature" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      event = await stripe.webhooks.constructEventAsync(body, sig, webhookSecret);
    } catch (sigErr: any) {
      console.error("Signature verification failed:", sigErr?.message || sigErr);
      return new Response(JSON.stringify({ error: "Invalid signature" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  } catch (initErr: any) {
    console.error("Webhook init error:", initErr);
    return new Response(JSON.stringify({ ok: true, swallowed: initErr.message }), { status: 200 });
  }

  // From here on, ALWAYS return 200 — log and swallow business errors.
  try {
    if (event.type !== "checkout.session.completed") {
      return new Response(JSON.stringify({ received: true, ignored: event.type }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const session = event.data.object as Stripe.Checkout.Session;
    const orderId = session.metadata?.order_id;
    if (!orderId) {
      console.error("Webhook: no order_id in session metadata", session.id);
      return new Response(JSON.stringify({ received: true, skipped: "no_order_id" }), { status: 200 });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select("*, order_dates(*)")
      .eq("id", orderId)
      .maybeSingle();

    if (orderErr || !order) {
      console.error("Webhook: order not found", orderId, orderErr);
      return new Response(JSON.stringify({ received: true, skipped: "order_not_found" }), { status: 200 });
    }

    if (order.status === "stripe_paid") {
      // Already paid — still attempt finalize (idempotent) in case earlier finalize partially failed
      try {
        await supabase.functions.invoke("finalize-stripe-order", { body: { orderId } });
      } catch (e) {
        console.error("Webhook: finalize (already-paid) error:", e);
      }
      return new Response(JSON.stringify({ received: true, already: "paid" }), { status: 200 });
    }

    if (order.status !== "stripe_pending") {
      console.log(`Webhook: order ${orderId} status=${order.status}, skipping`);
      return new Response(JSON.stringify({ received: true, skipped: order.status }), { status: 200 });
    }

    // Final blocked date check to prevent double-booking
    try {
      const { data: blocked } = await supabase.rpc("get_blocked_dates", { p_home_id: order.home_id });
      const blockedSet = new Set((blocked || []).map((b: any) => b.date));
      const orderDates = (order.order_dates as any[]) || [];
      const conflict = orderDates.find((od) => blockedSet.has(od.date));
      if (conflict) {
        await supabase.from("orders").update({ status: "stripe_failed" }).eq("id", orderId);
        if (session.payment_intent) {
          try {
            await stripe.refunds.create({ payment_intent: session.payment_intent as string });
          } catch (e) {
            console.error("Refund failed:", e);
          }
        }
        return new Response(JSON.stringify({ received: true, refunded: true }), { status: 200 });
      }
    } catch (e) {
      console.error("Webhook: blocked-date check failed:", e);
    }

    // Mark paid
    try {
      await supabase.from("orders").update({ status: "stripe_paid" }).eq("id", orderId);
    } catch (e) {
      console.error("Webhook: mark-paid failed:", e);
    }

    // Delegate side-effects to finalize-stripe-order (idempotent)
    try {
      await supabase.functions.invoke("finalize-stripe-order", { body: { orderId } });
    } catch (e) {
      console.error("Webhook: finalize invoke failed:", e);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("Webhook handler error (swallowed):", error);
    return new Response(JSON.stringify({ received: true, error: error.message }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
});
