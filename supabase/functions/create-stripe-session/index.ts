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
    if (!stripeKey) throw new Error("Stripe not configured");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const { orderId } = await req.json();
    if (!orderId) throw new Error("orderId required");

    // Get order with dates and home
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select("*, order_dates(*), homes(name)")
      .eq("id", orderId)
      .single();

    if (orderErr || !order) throw new Error("Order not found");
    if (order.status !== "stripe_pending") throw new Error("Order is not pending");

    // Server-side blocked date check
    const { data: blocked } = await supabase.rpc("get_blocked_dates", { p_home_id: order.home_id });
    const blockedSet = new Set((blocked || []).map((b: any) => b.date));
    const orderDates = order.order_dates as any[];

    // Hard cutoff: no same-day bookings after 3 PM Pacific
    const nowPacific = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
    const todayPacific = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    if (nowPacific.getHours() >= 15) {
      for (const od of orderDates) {
        if (od.date === todayPacific) {
          throw new Error("Same-day bookings close at 3 PM. Please choose another date.");
        }
      }
    }

    for (const od of orderDates) {
      if (blockedSet.has(od.date)) {
        throw new Error(`Date ${od.date} is no longer available`);
      }
    }

    // Server-side price validation using forecast bands / fallback
    const { data: settings } = await supabase
      .from("settings")
      .select("booking_window_days")
      .single();
    const windowDays = settings?.booking_window_days || 14;
    const lastBookable = new Date(`${todayPacific}T00:00:00Z`);
    lastBookable.setUTCDate(lastBookable.getUTCDate() + windowDays - 1);
    const lastBookableStr = lastBookable.toISOString().slice(0, 10);

    const [bandsResp, optsResp, fallbackResp, forecastResp] = await Promise.all([
      supabase.from("pricing_bands").select("*").order("sort_order"),
      supabase.from("pricing_band_options").select("*"),
      supabase.from("pricing_fallback_options").select("*"),
      supabase.from("daily_forecast").select("date, high_temp_f"),
    ]);
    const bands = bandsResp.data || [];
    const bandOpts = optsResp.data || [];
    const fallback = fallbackResp.data || [];
    const forecast = new Map((forecastResp.data || []).map((f: any) => [f.date, f.high_temp_f]));

    const priceFor = (date: string, temp: number): number | null => {
      const high = forecast.get(date);
      if (high !== undefined) {
        const band = bands.find((b: any) => high >= b.outdoor_low_f && high <= b.outdoor_high_f);
        if (band) {
          const opt = bandOpts.find((o: any) => o.band_id === band.id && o.temperature === temp);
          if (opt) return Number(opt.price_per_day);
        }
      }
      const fb = fallback.find((o: any) => o.temperature === temp);
      return fb ? Number(fb.price_per_day) : null;
    };

    let serverTotal = 0;
    for (const od of orderDates) {
      if (od.date < todayPacific || od.date > lastBookableStr) {
        throw new Error(`Date ${od.date} is outside the booking window`);
      }
      const price = priceFor(od.date, od.temperature);
      if (price === null) throw new Error(`No pricing available for ${od.date} at ${od.temperature}°F`);
      serverTotal += price;
    }

    if (Math.abs(serverTotal - Number(order.total)) > 0.01) {
      throw new Error("Price mismatch — please try again");
    }

    const stripe = new Stripe(stripeKey, { apiVersion: "2023-10-16" });

    // Determine return URL from request origin for embedded checkout
    const origin = req.headers.get("origin") || "https://id-preview--71ee5697-ad31-4604-a0c2-5a224ca1d02c.lovable.app";

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      ui_mode: "embedded",
      line_items: orderDates.map((od: any) => ({
        price_data: {
          currency: "usd",
          product_data: {
            name: `Pool Heat - ${(order.homes as any).name} - ${od.date} @ ${od.temperature}°F`,
          },
          unit_amount: Math.round(Number(od.price) * 100),
        },
        quantity: 1,
      })),
      return_url: `${origin}/?payment_status=success&order_id=${orderId}`,
      metadata: { order_id: orderId },
    });

    // Store session ID on order
    await supabase
      .from("orders")
      .update({ stripe_session_id: session.id })
      .eq("id", orderId);

    return new Response(JSON.stringify({ clientSecret: session.client_secret }), {
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
