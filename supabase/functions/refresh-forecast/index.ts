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
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: settings, error: settingsErr } = await supabase
      .from("settings")
      .select("id, forecast_zip, forecast_lat, forecast_lon, booking_window_days")
      .single();
    if (settingsErr) throw settingsErr;

    const zip = (settings?.forecast_zip || "").trim();
    if (!zip) {
      return new Response(JSON.stringify({ error: "No forecast_zip configured" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Geocode zip via Open-Meteo (US postal codes)
    let lat = Number(settings?.forecast_lat);
    let lon = Number(settings?.forecast_lon);
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(zip)}&country=US&count=1`;
    const geoResp = await fetch(geoUrl);
    if (geoResp.ok) {
      const geo = await geoResp.json();
      if (geo?.results?.[0]) {
        lat = geo.results[0].latitude;
        lon = geo.results[0].longitude;
      }
    }
    if (!lat || !lon) {
      return new Response(JSON.stringify({ error: `Could not geocode zip ${zip}` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const days = Math.min(Math.max(settings?.booking_window_days || 14, 1), 16);
    const fcUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max&temperature_unit=fahrenheit&timezone=America/Los_Angeles&forecast_days=${days}`;
    const fcResp = await fetch(fcUrl);
    if (!fcResp.ok) throw new Error(`Forecast fetch failed: ${fcResp.status}`);
    const fc = await fcResp.json();
    const dates: string[] = fc?.daily?.time || [];
    const highs: number[] = fc?.daily?.temperature_2m_max || [];
    if (!dates.length) throw new Error("No forecast data returned");

    const rows = dates.map((d, i) => ({
      date: d,
      high_temp_f: Math.round(highs[i]),
      zip,
      fetched_at: new Date().toISOString(),
    }));

    const { error: upErr } = await supabase
      .from("daily_forecast")
      .upsert(rows, { onConflict: "date" });
    if (upErr) throw upErr;

    // Delete past forecasts
    const todayPacific = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    await supabase.from("daily_forecast").delete().lt("date", todayPacific);

    await supabase
      .from("settings")
      .update({
        forecast_lat: lat,
        forecast_lon: lon,
        forecast_last_fetched_at: new Date().toISOString(),
      })
      .eq("id", settings!.id);

    return new Response(
      JSON.stringify({ ok: true, count: rows.length, zip, lat, lon }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e: any) {
    console.error("refresh-forecast error:", e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});