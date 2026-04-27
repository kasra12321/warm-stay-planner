import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * screenlogic-control
 *
 * Thin proxy to a Raspberry Pi running the companion `pi-server` Node service.
 * The Pi must be reachable at SCREENLOGIC_PI_URL (e.g. https://poolpi.example.com)
 * and authenticated via SCREENLOGIC_PI_AUTH_TOKEN (shared bearer token).
 *
 * Mirrors the action surface of `iaqualink-control` so callers (sync-pool-occupancy,
 * process-reminders, admin UI) can dispatch by `controller_type` without branching
 * on shape:
 *   - status               → { connected, hasSecrets }
 *   - get-status           → { success, status: { pool_temp, pool_set_point, pool_heater, ... } }
 *   - set-temp             → { success, actual_temp, verified }
 *   - ping                 → raw Pi /healthz response (admin debug)
 */

interface PiStatus {
  pool_temp?: number;
  pool_set_point?: number;
  pool_heater?: string; // "0" off, "1" on — matches iAquaLink shape for UI parity
  spa_temp?: number;
  spa_set_point?: number;
  spa_heater?: string;
  air_temp?: number;
  raw?: unknown;
  status?: string;
  response?: string;
}

async function callPi(
  path: string,
  body: Record<string, unknown> | null,
  piUrl: string,
  piToken: string,
) {
  const url = `${piUrl.replace(/\/$/, "")}${path}`;
  const r = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${piToken}`,
    },
    body: body ? JSON.stringify(body) : undefined,
    // Pi over Cloudflare Tunnel can be slow on cold connect (RemoteLogin handshake)
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // leave as null, surface raw text in error
  }
  if (!r.ok) {
    throw new Error(`Pi ${path} ${r.status}: ${json?.error || text || "unknown"}`);
  }
  return json;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const piUrl = Deno.env.get("SCREENLOGIC_PI_URL");
    const piToken = Deno.env.get("SCREENLOGIC_PI_AUTH_TOKEN");

    const supabase = createClient(supabaseUrl, serviceKey);
    const body = await req.json().catch(() => ({}));
    const action: string = body.action;

    const hasSecrets = !!(piUrl && piToken);

    if (action === "status") {
      // Lightweight reachability check used by admin UI
      let connected = false;
      let lastError: string | null = null;
      if (hasSecrets) {
        try {
          await callPi("/healthz", null, piUrl!, piToken!);
          connected = true;
        } catch (e: any) {
          lastError = e.message;
        }
      }
      return new Response(
        JSON.stringify({ hasSecrets, connected, lastError }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!hasSecrets) {
      return new Response(
        JSON.stringify({ error: "SCREENLOGIC_PI_URL or SCREENLOGIC_PI_AUTH_TOKEN not configured" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (action === "ping") {
      const result = await callPi("/healthz", null, piUrl!, piToken!);
      return new Response(JSON.stringify({ success: true, result }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // All home-scoped actions need credentials from `homes`
    const home_id: string | undefined = body.home_id;
    if (!home_id) {
      return new Response(JSON.stringify({ error: "home_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: home, error: homeErr } = await supabase
      .from("homes")
      .select("id, name, internal_name, controller_type, screenlogic_system_name, screenlogic_password")
      .eq("id", home_id)
      .single();
    if (homeErr || !home) {
      return new Response(JSON.stringify({ error: `home not found: ${homeErr?.message}` }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!home.screenlogic_system_name) {
      return new Response(
        JSON.stringify({ error: "Home is missing ScreenLogic system name" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const credentials = {
      systemName: home.screenlogic_system_name,
      password: home.screenlogic_password ?? "",
    };

    if (action === "get-status") {
      try {
        const result = await callPi("/api/pool/status", credentials, piUrl!, piToken!);
        const status: PiStatus = result?.status || result || {};
        return new Response(JSON.stringify({ success: true, status }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (e: any) {
        // Surface offline / unreachable conditions in the same shape iAquaLink uses
        // so the eco-sync drift logic ("status === 'Offline'") works uniformly.
        return new Response(
          JSON.stringify({
            success: true,
            status: { status: "Offline", response: "Error", error: e.message },
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    if (action === "set-temp") {
      const temp = Number(body.temp);
      if (!Number.isFinite(temp) || temp < 50 || temp > 110) {
        return new Response(JSON.stringify({ error: "temp must be 50-110" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const result = await callPi(
        "/api/pool/heater",
        { ...credentials, temp },
        piUrl!,
        piToken!,
      );
      // Pi returns { success, actual_temp, verified }
      const actual_temp = typeof result?.actual_temp === "number" ? result.actual_temp : temp;
      const verified = result?.verified === true;
      return new Response(
        JSON.stringify({ success: true, actual_temp, verified, raw: result }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ error: `unknown action: ${action}` }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("screenlogic-control error:", e);
    return new Response(JSON.stringify({ error: e.message || String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});