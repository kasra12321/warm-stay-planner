import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) throw new Error("STRIPE_SECRET_KEY not configured");

    const stripe = new Stripe(stripeKey, { apiVersion: "2023-10-16" });
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Find stripe_pending orders older than 1 hour with a session id
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: pending, error } = await supabase
      .from("orders")
      .select("id, stripe_session_id, created_at, status")
      .eq("status", "stripe_pending")
      .not("stripe_session_id", "is", null)
      .lt("created_at", cutoff)
      .limit(50);

    if (error) throw error;

    const reconciled: any[] = [];

    for (const order of pending || []) {
      try {
        const session = await stripe.checkout.sessions.retrieve(order.stripe_session_id!);
        if (session.payment_status === "paid") {
          await supabase.from("orders").update({ status: "stripe_paid" }).eq("id", order.id);
          await supabase.functions.invoke("finalize-stripe-order", { body: { orderId: order.id } });
          reconciled.push({ id: order.id, action: "marked_paid_and_finalized" });
        } else if (session.status === "expired") {
          await supabase.from("orders").update({ status: "stripe_failed" }).eq("id", order.id);
          reconciled.push({ id: order.id, action: "marked_failed" });
        } else {
          reconciled.push({ id: order.id, action: "still_pending", payment_status: session.payment_status });
        }
      } catch (e: any) {
        console.error(`Reconcile failed for order ${order.id}:`, e?.message || e);
        reconciled.push({ id: order.id, action: "error", error: e?.message });
      }
    }

    return new Response(JSON.stringify({ ok: true, count: reconciled.length, reconciled }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("reconcile-stripe-orders error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});