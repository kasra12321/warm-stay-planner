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

/**
 * Normalize a ScreenLogic system name to the form Pentair's dispatcher expects:
 *   "Pentair: XX-XX-XX"
 * Accepts the raw 6-hex code (e.g. "0CB6F9"), dashed form ("0C-B6-F9"),
 * the full prefixed form, lowercase, with stray spaces, or with letter O
 * mistakenly typed in place of zero. Returns null if it can't be coerced
 * into a valid 6-hex identifier.
 */
function normalizeSystemName(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = String(input).trim();
  // Strip a leading "Pentair:" (any casing/spacing) if present
  s = s.replace(/^pentair\s*:\s*/i, "");
  // Common typo: capital O instead of zero
  s = s.replace(/O/gi, "0");
  // Remove anything that's not hex
  const hex = s.replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
  if (hex.length !== 6) return null;
  return `Pentair: ${hex.slice(0, 2)}-${hex.slice(2, 4)}-${hex.slice(4, 6)}`;
}

/**
 * Classify an error coming back from the Pi call so the UI can show a
 * meaningful message instead of a raw stack trace.
 *
 *  - tunnel_down  → Cloudflare returned HTML (Pi service offline)
 *  - unauthorized → Pi rejected our bearer token
 *  - screenlogic  → Pi reached Pentair but Pentair / adapter errored
 *  - timeout      → fetch aborted
 *  - unknown      → fallback
 */
function classifyPiError(status: number, rawText: string, parsed: any): {
  kind: "tunnel_down" | "unauthorized" | "screenlogic" | "timeout" | "unknown";
  message: string;
} {
  const looksHtml = /^\s*<(?:!doctype|html)/i.test(rawText || "");
  if (status === 401 || status === 403) {
    return { kind: "unauthorized", message: "Pi rejected the auth token. Verify SCREENLOGIC_PI_AUTH_TOKEN matches the Pi's /etc/poolheat.env." };
  }
  // Only treat as "tunnel down" if Cloudflare itself served an HTML error page.
  // The Pi's poolheat service also returns 502 when the ScreenLogic dispatcher
  // / adapter fails — in that case we get JSON back and want to surface it.
  if (looksHtml) {
    return {
      kind: "tunnel_down",
      message:
        "Cloudflare returned an HTML error page (no JSON from poolheat). " +
        "/healthz works but /api/pool/* does not — likely a Cloudflare Tunnel " +
        "ingress path restriction or the route is crashing. On the Pi check: " +
        "`sudo journalctl -u poolheat -n 50` and your `cloudflared` ingress config.",
    };
  }
  const piMsg = parsed?.error || parsed?.message || rawText || `HTTP ${status}`;
  return { kind: "screenlogic", message: `ScreenLogic error (HTTP ${status}): ${piMsg}` };
}

async function callPi(
  path: string,
  body: Record<string, unknown> | null,
  piUrl: string,
  piToken: string,
) {
  const url = `${piUrl.replace(/\/$/, "")}${path}`;
  console.log(`[screenlogic-control] → Pi ${body ? "POST" : "GET"} ${url}`, body ? { systemName: (body as any).systemName } : {});
  let r: Response;
  try {
    r = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${piToken}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      // Pi over Cloudflare Tunnel can be slow on cold connect (RemoteLogin handshake)
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e: any) {
    console.error(`[screenlogic-control] ✗ fetch failed for ${url}:`, e?.message || e);
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      const err: any = new Error("Timed out waiting for the Raspberry Pi bridge (30s). The Pi may be offline or the Pentair handshake is hung.");
      err.kind = "timeout";
      throw err;
    }
    const err: any = new Error(`Cannot reach Raspberry Pi bridge at ${piUrl}: ${e?.message || e}`);
    err.kind = "tunnel_down";
    throw err;
  }
  const text = await r.text();
  console.log(`[screenlogic-control] ← Pi status=${r.status} bytes=${text.length} contentType=${r.headers.get("content-type") || "?"}`);
  if (!r.ok) {
    console.error(`[screenlogic-control] Pi error body (first 500):`, text.slice(0, 500));
  }
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // leave as null, surface raw text in error
  }
  if (!r.ok) {
    const { kind, message } = classifyPiError(r.status, text, json);
    const err: any = new Error(message);
    err.kind = kind;
    err.status = r.status;
    throw err;
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

    const normalizedSystemName = normalizeSystemName(home.screenlogic_system_name);
    if (!normalizedSystemName) {
      return new Response(
        JSON.stringify({
          error: `Invalid ScreenLogic system name "${home.screenlogic_system_name}". Expected a 6-character hex code like "0C-B6-F9" or "Pentair: 0C-B6-F9".`,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const credentials = {
      systemName: normalizedSystemName,
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
            status: {
              status: "Offline",
              response: "Error",
              error: e.message,
              error_kind: e.kind || "unknown",
            },
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    if (action === "set-temp") {
      const temp = Number(body.temp);
      const bodyType: "pool" | "spa" = body.body === "spa" ? "spa" : "pool";
      if (!Number.isFinite(temp) || temp < 50 || temp > 110) {
        return new Response(JSON.stringify({ error: "temp must be 50-110" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      try {
        const result = await callPi(
          "/api/pool/heater",
          { ...credentials, temp, body: bodyType },
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
      } catch (e: any) {
        return new Response(
          JSON.stringify({ error: e.message, error_kind: e.kind || "unknown" }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    if (action === "list-circuits") {
      try {
        const result = await callPi("/api/pool/circuits", credentials, piUrl!, piToken!);
        return new Response(JSON.stringify({ success: true, circuits: result?.circuits || [] }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message, error_kind: e.kind || "unknown" }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    if (action === "set-circuit") {
      const circuitId = Number(body.circuit_id);
      const on = body.on === true;
      if (!Number.isFinite(circuitId) || circuitId <= 0) {
        return new Response(JSON.stringify({ error: "circuit_id required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      try {
        const result = await callPi("/api/pool/circuit", { ...credentials, circuitId, on }, piUrl!, piToken!);
        return new Response(JSON.stringify({ success: true, ...result }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message, error_kind: e.kind || "unknown" }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
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