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

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: order, error } = await supabase
      .from("orders")
      .select("*, homes(name), order_dates(*)")
      .eq("id", orderId)
      .single();
    if (error || !order) throw new Error("Order not found");

    if (!order.guest_email) {
      return new Response(JSON.stringify({ skipped: "no email" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Idempotency: don't send the receipt twice. Multiple callers
    // (stripe-webhook → finalize-stripe-order, browser return on /Index,
    // and the notify-admin-order fanout for non-Stripe flows) can all
    // race to send this. First one in wins.
    if ((order as any).guest_receipt_sent_at) {
      return new Response(JSON.stringify({ skipped: "already_sent" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: settings } = await supabase.from("settings").select("*").single();

    const home = order.homes as any;
    const dates = (order.order_dates as any[]).sort((a, b) => a.date.localeCompare(b.date));
    const fmt = (d: string) => new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

    const dateRows = dates.map((d) =>
      `<tr>
         <td style="padding:6px 0;color:#444">${fmt(d.date)}</td>
         <td style="padding:6px 0;color:#444">${d.temperature}°F</td>
         <td style="padding:6px 0;color:#444;text-align:right">$${Number(d.price).toFixed(2)}</td>
       </tr>`).join("");

    const method = order.payment_method as string;
    const methodLabel =
      method === "apple_cash" ? "Apple Cash" :
      method === "stripe" ? "Credit Card" :
      method.charAt(0).toUpperCase() + method.slice(1);

    let paymentBlock = "";
    if (method === "venmo") {
      const handle = (settings?.venmo_handle || "").replace(/^@/, "");
      paymentBlock = `
        <p style="margin:0 0 6px"><strong>Send via Venmo to:</strong> @${handle}</p>
        <p style="margin:0 0 6px;color:#666;font-size:13px">${settings?.venmo_instructions || ""}</p>`;
    } else if (method === "zelle") {
      paymentBlock = `
        <p style="margin:0 0 6px"><strong>Send via Zelle:</strong></p>
        <p style="margin:0 0 6px;color:#666;font-size:13px;white-space:pre-line">${settings?.zelle_instructions || ""}</p>`;
    } else if (method === "apple_cash") {
      paymentBlock = `
        <p style="margin:0 0 6px"><strong>Send Apple Cash to:</strong> ${settings?.apple_cash_phone || ""}</p>
        <p style="margin:0 0 6px;color:#666;font-size:13px">${settings?.apple_cash_instructions || ""}</p>`;
    } else if (method === "stripe") {
      paymentBlock = `<p style="margin:0;color:#444">Your card payment was processed successfully.</p>`;
    }

    const subjectStatus = method === "stripe" ? "Receipt" : "Order Confirmation";

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
        <h2 style="color:#1a1a2e">Thanks for your pool heat booking!</h2>
        <p style="color:#444">Hi ${order.guest_name}, here are your order details for <strong>${home?.name}</strong>.</p>

        <div style="background:#f8f9fa;border-radius:8px;padding:16px 20px;margin:16px 0">
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <thead>
              <tr style="text-align:left;color:#888">
                <th style="padding:0 0 6px">Date</th>
                <th style="padding:0 0 6px">Temp</th>
                <th style="padding:0 0 6px;text-align:right">Price</th>
              </tr>
            </thead>
            <tbody>${dateRows}</tbody>
            <tfoot>
              <tr><td colspan="3" style="border-top:1px solid #ddd;padding-top:8px"></td></tr>
              <tr>
                <td colspan="2" style="font-weight:bold">Total</td>
                <td style="text-align:right;font-weight:bold">$${Number(order.total).toFixed(2)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:16px 20px;margin:16px 0">
          <p style="margin:0 0 10px;font-size:15px"><strong>Payment Method:</strong> ${methodLabel}</p>
          ${paymentBlock}
        </div>

        <p style="color:#888;font-size:12px">Order #${order.id.slice(0, 8)}</p>
      </div>
    `;

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    if (!LOVABLE_API_KEY || !RESEND_API_KEY) throw new Error("Email not configured");

    const r = await fetch("https://connector-gateway.lovable.dev/resend/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "X-Connection-Api-Key": RESEND_API_KEY,
      },
      body: JSON.stringify({
        from: "Pool Heat <noreply@ocadventurehomes.com>",
        to: [order.guest_email],
        subject: `${subjectStatus}: ${home?.name} ($${Number(order.total).toFixed(2)})`,
        html,
      }),
    });
    if (!r.ok) {
      const txt = await r.text();
      console.error("Guest receipt email failed:", txt);
      throw new Error(txt);
    }

    // Mark sent so retries / parallel callers don't re-send.
    await supabase
      .from("orders")
      .update({ guest_receipt_sent_at: new Date().toISOString() })
      .eq("id", orderId);

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("send-guest-receipt error:", e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});