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
    if (!orderId) {
      return new Response(JSON.stringify({ error: "orderId required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select("*, homes(name, internal_name), order_dates(*)")
      .eq("id", orderId)
      .maybeSingle();

    if (orderErr || !order) {
      console.error("finalize: order not found", orderId, orderErr);
      return new Response(JSON.stringify({ ok: true, skipped: "order_not_found" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (order.status !== "stripe_paid") {
      console.log(`finalize: order ${orderId} status=${order.status}, skipping`);
      return new Response(JSON.stringify({ ok: true, skipped: "not_paid" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results: Record<string, string> = {};

    // 1. Create reminders (idempotent via reminders_created_at)
    if (!order.reminders_created_at) {
      try {
        const { error } = await supabase.functions.invoke("create-reminders", {
          body: { orderId },
        });
        if (error) throw error;
        await supabase
          .from("orders")
          .update({ reminders_created_at: new Date().toISOString() })
          .eq("id", orderId);
        results.reminders = "created";
      } catch (e: any) {
        console.error("finalize: reminders failed:", e?.message || e);
        results.reminders = `error: ${e?.message || e}`;
      }
    } else {
      results.reminders = "already_done";
    }

    // 2. Notify admin (idempotent via admin_notified_at)
    if (!order.admin_notified_at) {
      try {
        const { error } = await supabase.functions.invoke("notify-admin-order", {
          body: { orderId },
        });
        if (error) throw error;
        await supabase
          .from("orders")
          .update({ admin_notified_at: new Date().toISOString() })
          .eq("id", orderId);
        results.admin_notify = "sent";
      } catch (e: any) {
        console.error("finalize: admin notify failed:", e?.message || e);
        results.admin_notify = `error: ${e?.message || e}`;
      }
    } else {
      results.admin_notify = "already_done";
    }

    // 3. Send guest SMS (idempotent via guest_sms_sent_at)
    if (!order.guest_sms_sent_at && order.guest_mobile) {
      try {
        const { error } = await supabase.functions.invoke("send-guest-sms", {
          body: { orderId },
        });
        if (error) throw error;
        await supabase
          .from("orders")
          .update({ guest_sms_sent_at: new Date().toISOString() })
          .eq("id", orderId);
        results.guest_sms = "sent";
      } catch (e: any) {
        console.error("finalize: guest SMS failed:", e?.message || e);
        results.guest_sms = `error: ${e?.message || e}`;
      }
    } else {
      results.guest_sms = order.guest_sms_sent_at ? "already_done" : "no_mobile";
    }

    // 4. Send guest receipt email (best-effort, not idempotency-tracked)
    if (order.guest_email) {
      try {
        await supabase.functions.invoke("send-guest-receipt", { body: { orderId } });
        results.guest_receipt = "sent";
      } catch (e: any) {
        console.error("finalize: guest receipt failed:", e?.message || e);
        results.guest_receipt = `error: ${e?.message || e}`;
      }
    } else {
      results.guest_receipt = "no_email";
    }

    return new Response(JSON.stringify({ ok: true, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("finalize-stripe-order error:", error);
    // Return 200 so callers (webhook) don't retry on transient errors
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});