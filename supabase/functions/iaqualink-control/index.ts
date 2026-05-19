import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const IAQUA_API_KEY = "EOOEMOW4YR6QNB07";
const LOGIN_URL = "https://prod.zodiac-io.com/users/v1/login";
const DEVICES_URL = "https://r-api.iaqualink.net/devices.json";
const SESSION_URL = "https://p-api.iaqualink.net/v1/mobile/session.json";

async function iaquaLogin(email: string, password: string) {
  // Try snake_case first
  let r = await fetch(LOGIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ api_key: IAQUA_API_KEY, email, password }),
  });
  if (!r.ok && r.status >= 400 && r.status < 500) {
    // Fallback to camelCase
    r = await fetch(LOGIN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ apiKey: IAQUA_API_KEY, email, password }),
    });
  }
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`iAquaLink login failed [${r.status}]: ${text}`);
  }
  return r.json() as Promise<{ id: string; authentication_token: string; session_id: string; email?: string }>;
}

async function iaquaListDevices(authToken: string, userId: string) {
  const url =
    `${DEVICES_URL}?api_key=${IAQUA_API_KEY}` +
    `&authentication_token=${encodeURIComponent(authToken)}` +
    `&user_id=${encodeURIComponent(userId)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`devices ${r.status}`);
  return r.json() as Promise<Array<{ serial_number: string; name: string; device_type?: string }>>;
}

async function iaquaGetHome(serial: string, sessionId: string) {
  const url =
    `${SESSION_URL}?actionID=command&command=get_home` +
    `&serial=${encodeURIComponent(serial)}` +
    `&sessionID=${encodeURIComponent(sessionId)}`;
  const r = await fetch(url);
  return { status: r.status, body: r.ok ? await r.json() : await r.text() };
}

// Fetch the one-touch macro list/state for an iAquaLink panel. Returns the
// raw response body; one-touches appear under `onetouch_screen` (similar
// shape to `home_screen`) with keys like onetouch_N_label / onetouch_N_state.
async function iaquaGetOneTouch(serial: string, sessionId: string) {
  const url =
    `${SESSION_URL}?actionID=command&command=get_onetouch` +
    `&serial=${encodeURIComponent(serial)}` +
    `&sessionID=${encodeURIComponent(sessionId)}`;
  const r = await fetch(url);
  return { status: r.status, body: r.ok ? await r.json() : await r.text() };
}

async function iaquaSetPoolTemp(serial: string, sessionId: string, tempF: number, tempIndex: 1 | 2 = 1) {
  const param = tempIndex === 2 ? "temp2" : "temp1";
  const url =
    `${SESSION_URL}?actionID=command&command=set_temps` +
    `&serial=${encodeURIComponent(serial)}` +
    `&sessionID=${encodeURIComponent(sessionId)}` +
    `&${param}=${tempF}`;
  const r = await fetch(url);
  return { status: r.status, body: r.ok ? await r.json() : await r.text() };
}

// Generic command sender. iAquaLink toggle commands (set_aux_X, set_pool_heater,
// set_spa_heater, set_pool_pump, etc.) just toggle current state — they don't
// accept an on/off arg. Caller is responsible for reading state first if it
// needs to enforce a desired absolute state.
async function iaquaSendCommand(serial: string, sessionId: string, command: string) {
  const url =
    `${SESSION_URL}?actionID=command&command=${encodeURIComponent(command)}` +
    `&serial=${encodeURIComponent(serial)}` +
    `&sessionID=${encodeURIComponent(sessionId)}`;
  const r = await fetch(url);
  return { status: r.status, body: r.ok ? await r.json() : await r.text() };
}

// Reusable helper: gets a valid session, re-logging in if needed
async function getValidSession(supabase: any): Promise<{ session_id: string; auth_token: string; user_id_external: string; email: string }> {
  const email = Deno.env.get("IAQUALINK_EMAIL");
  const password = Deno.env.get("IAQUALINK_PASSWORD");
  if (!email || !password) throw new Error("IAQUALINK_EMAIL or IAQUALINK_PASSWORD not configured");

  const { data: cached } = await supabase
    .from("iaqualink_credentials")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (cached?.session_id && cached?.auth_token && cached?.user_id_external) {
    return {
      session_id: cached.session_id,
      auth_token: cached.auth_token,
      user_id_external: cached.user_id_external,
      email,
    };
  }

  // Login fresh
  const fresh = await iaquaLogin(email, password);
  const row = {
    email,
    auth_token: fresh.authentication_token,
    session_id: fresh.session_id,
    user_id_external: fresh.id,
    last_login_at: new Date().toISOString(),
  };
  if (cached?.id) {
    await supabase.from("iaqualink_credentials").update(row).eq("id", cached.id);
  } else {
    await supabase.from("iaqualink_credentials").insert(row);
  }
  return { session_id: fresh.session_id, auth_token: fresh.authentication_token, user_id_external: fresh.id, email };
}

async function withRelogin<T>(
  supabase: any,
  call: (sessionId: string) => Promise<{ status: number; body: any }>,
): Promise<{ status: number; body: any }> {
  const session = await getValidSession(supabase);
  let res = await call(session.session_id);
  if (res.status === 401) {
    const email = Deno.env.get("IAQUALINK_EMAIL")!;
    const password = Deno.env.get("IAQUALINK_PASSWORD")!;
    const fresh = await iaquaLogin(email, password);
    const row = {
      email,
      auth_token: fresh.authentication_token,
      session_id: fresh.session_id,
      user_id_external: fresh.id,
      last_login_at: new Date().toISOString(),
    };
    const { data: existing } = await supabase
      .from("iaqualink_credentials")
      .select("id")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing?.id) {
      await supabase.from("iaqualink_credentials").update(row).eq("id", existing.id);
    } else {
      await supabase.from("iaqualink_credentials").insert(row);
    }
    res = await call(fresh.session_id);
  }
  return res;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Auth: verify caller is admin (skip for internal service calls with service-role auth)
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    // Treat as service-role if the token matches the service key exactly,
    // OR if it's a JWT whose `role` claim is `service_role`. The strict
    // string match alone is fragile because Supabase's signing-key system
    // can hand different functions different forms of the service key
    // (legacy JWT vs. new sb_secret_...), which caused sync-pool-occupancy
    // calls to be rejected as "Unauthorized".
    let isServiceRole = token === serviceKey;
    if (!isServiceRole && token && token.split(".").length === 3) {
      try {
        const payload = JSON.parse(
          atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
        );
        if (payload?.role === "service_role") isServiceRole = true;
      } catch {
        // not a decodable JWT — fall through to user auth check
      }
    }

    if (!isServiceRole) {
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: userData, error: userErr } = await userClient.auth.getUser();
      if (userErr || !userData.user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const adminClient = createClient(supabaseUrl, serviceKey);
      const { data: roleData } = await adminClient
        .from("user_roles")
        .select("role")
        .eq("user_id", userData.user.id)
        .eq("role", "admin")
        .maybeSingle();
      if (!roleData) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const supabase = createClient(supabaseUrl, serviceKey);
    const body = await req.json();
    const action = body.action as string;

    if (action === "login") {
      // Force a fresh login + cache
      const email = Deno.env.get("IAQUALINK_EMAIL");
      const password = Deno.env.get("IAQUALINK_PASSWORD");
      if (!email || !password) {
        return new Response(JSON.stringify({ error: "IAQUALINK_EMAIL/PASSWORD secrets not set" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const fresh = await iaquaLogin(email, password);
      const { data: existing } = await supabase
        .from("iaqualink_credentials")
        .select("id")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const row = {
        email,
        auth_token: fresh.authentication_token,
        session_id: fresh.session_id,
        user_id_external: fresh.id,
        last_login_at: new Date().toISOString(),
      };
      if (existing?.id) {
        await supabase.from("iaqualink_credentials").update(row).eq("id", existing.id);
      } else {
        await supabase.from("iaqualink_credentials").insert(row);
      }
      return new Response(JSON.stringify({ success: true, email, last_login_at: row.last_login_at }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "list-devices") {
      const session = await getValidSession(supabase);
      const devices = await iaquaListDevices(session.auth_token, session.user_id_external);
      return new Response(JSON.stringify({ success: true, devices }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "set-temp") {
      const { home_id, temp } = body;
      if (!home_id || typeof temp !== "number") {
        return new Response(JSON.stringify({ error: "home_id and temp required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data: home } = await supabase.from("homes").select("*").eq("id", home_id).maybeSingle();
      if (!home?.iaqualink_serial) {
        return new Response(JSON.stringify({ error: "Home has no iAquaLink serial" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const tempIndex = (home.iaqualink_temp_sensor_index === 2 ? 2 : 1) as 1 | 2;
      const res = await withRelogin(supabase, (sid) => iaquaSetPoolTemp(home.iaqualink_serial, sid, temp, tempIndex));
      if (res.status >= 400) {
        return new Response(JSON.stringify({ error: `set_temps ${res.status}: ${JSON.stringify(res.body)}` }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // Verify: read pool back and compare actual setpoint to target
      let actualTemp: number | null = null;
      let verified = false;
      try {
        // Small delay so iAquaLink reflects the new value
        await new Promise((r) => setTimeout(r, 2000));
        const verify = await withRelogin(supabase, (sid) => iaquaGetHome(home.iaqualink_serial, sid));
        if (verify.status < 400) {
          const homeScreen = (verify.body as any).home_screen || [];
          const flat: Record<string, string> = {};
          for (const row of homeScreen) for (const [k, v] of Object.entries(row)) flat[k] = String(v);
          // tempIndex maps to a specific setpoint field on the panel:
          //   index 1 -> temp1 -> spa_set_point (on dual pool/spa controllers)
          //                       or pool_set_point (on pool-only controllers)
          //   index 2 -> temp2 -> pool_set_point (on dual pool/spa controllers)
          // We verify against the field that matches the index we actually wrote to,
          // so a misconfigured index surfaces as "not verified" instead of silently
          // landing on the wrong setpoint.
          const primaryField = tempIndex === 2 ? "pool_set_point" : "spa_set_point";
          const fallbackField = tempIndex === 2 ? "spa_set_point" : "pool_set_point";
          const primaryVal = parseInt(flat[primaryField], 10);
          const fallbackVal = parseInt(flat[fallbackField], 10);
          // Pool-only controllers report only pool_set_point even when index=1, so
          // accept the fallback when the primary field is empty/NaN.
          if (!isNaN(primaryVal) && primaryVal === temp) {
            actualTemp = primaryVal;
            verified = true;
          } else if (isNaN(primaryVal) && !isNaN(fallbackVal) && fallbackVal === temp) {
            actualTemp = fallbackVal;
            verified = true;
          } else if (!isNaN(primaryVal)) {
            actualTemp = primaryVal;
          } else if (!isNaN(fallbackVal)) {
            actualTemp = fallbackVal;
          }
        }
      } catch (e) {
        console.error("verify failed", e);
      }
      return new Response(
        JSON.stringify({ success: true, result: res.body, verified, actual_temp: actualTemp, target_temp: temp }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (action === "get-status") {
      const { home_id } = body;
      if (!home_id) {
        return new Response(JSON.stringify({ error: "home_id required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data: home } = await supabase.from("homes").select("*").eq("id", home_id).maybeSingle();
      if (!home?.iaqualink_serial) {
        return new Response(JSON.stringify({ error: "Home has no iAquaLink serial" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const res = await withRelogin(supabase, (sid) => iaquaGetHome(home.iaqualink_serial, sid));
      if (res.status >= 400) {
        return new Response(JSON.stringify({ error: `get_home ${res.status}: ${JSON.stringify(res.body)}` }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // Parse home_screen array into a flat object
      const homeScreen = (res.body as any).home_screen || [];
      const flat: Record<string, string> = {};
      for (const row of homeScreen) {
        for (const [k, v] of Object.entries(row)) flat[k] = String(v);
      }
      // Normalize the active set point based on the configured sensor index.
      // index 1 -> temp1 -> spa_set_point on dual pool/spa controllers, or
      //                     pool_set_point on pool-only controllers
      // index 2 -> temp2 -> pool_set_point on dual controllers
      const tempIndex = (home.iaqualink_temp_sensor_index === 2 ? 2 : 1) as 1 | 2;
      const primaryField = tempIndex === 2 ? "pool_set_point" : "spa_set_point";
      const fallbackField = tempIndex === 2 ? "spa_set_point" : "pool_set_point";
      const primaryVal = parseInt(flat[primaryField], 10);
      const fallbackVal = parseInt(flat[fallbackField], 10);
      let activeSetPoint: number | null = null;
      if (!isNaN(primaryVal)) activeSetPoint = primaryVal;
      else if (!isNaN(fallbackVal)) activeSetPoint = fallbackVal;
      // Override pool_set_point in the returned status with the active one so
      // the admin UI shows the setpoint that actually corresponds to this
      // home's pool sensor (e.g. Athens uses temp1 -> spa_set_point).
      if (activeSetPoint != null) flat.pool_set_point = String(activeSetPoint);
      return new Response(JSON.stringify({ success: true, status: flat, raw: res.body, active_set_point: activeSetPoint, temp_index: tempIndex }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "status") {
      // Return cached connection info
      const { data: cached } = await supabase
        .from("iaqualink_credentials")
        .select("email, last_login_at")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const hasSecrets = !!(Deno.env.get("IAQUALINK_EMAIL") && Deno.env.get("IAQUALINK_PASSWORD"));
      const hasHospitable = !!Deno.env.get("HOSPITABLE_PAT");
      return new Response(JSON.stringify({ success: true, connected: !!cached, hasSecrets, hasHospitable, cached }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "test-hospitable-property") {
      const { property_id } = body;
      const pat = Deno.env.get("HOSPITABLE_PAT");
      if (!pat) {
        return new Response(JSON.stringify({ error: "HOSPITABLE_PAT not configured" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!property_id) {
        return new Response(JSON.stringify({ error: "property_id required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const start = new Date().toISOString().slice(0, 10);
      const end = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const url = `https://public.api.hospitable.com/v2/reservations?properties[]=${encodeURIComponent(
        property_id,
      )}&start_date=${start}&end_date=${end}&date_query=checkin`;
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${pat}`, Accept: "application/json" },
      });
      const text = await r.text();
      if (!r.ok) {
        return new Response(JSON.stringify({ error: `Hospitable ${r.status}: ${text}` }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const data = JSON.parse(text);
      const reservations = (data.data || []).filter((r: any) => r.status === "accepted");
      const next = reservations[0] || null;
      return new Response(
        JSON.stringify({
          success: true,
          count: reservations.length,
          next: next ? { check_in: next.check_in, check_out: next.check_out, guest: next.guest?.first_name } : null,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (action === "disconnect") {
      await supabase.from("iaqualink_credentials").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Toggle a numbered aux (1-7) on/off. iAquaLink commands toggle, so we
    // read state first and only send the command if the current state
    // differs from the desired state. Returns the post-action state.
    if (action === "set-aux" || action === "set-heater") {
      const { home_id, on } = body;
      const auxIndex = action === "set-aux" ? Number(body.aux_index) : null;
      const heaterKind = action === "set-heater" ? String(body.heater || "spa") : null; // "spa" | "pool"
      if (!home_id || typeof on !== "boolean") {
        return new Response(JSON.stringify({ error: "home_id and on(boolean) required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (action === "set-aux" && (!Number.isFinite(auxIndex!) || auxIndex! < 1 || auxIndex! > 7)) {
        return new Response(JSON.stringify({ error: "aux_index must be 1-7" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data: home } = await supabase.from("homes").select("*").eq("id", home_id).maybeSingle();
      if (!home?.iaqualink_serial) {
        return new Response(JSON.stringify({ error: "Home has no iAquaLink serial" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const stateKey = action === "set-aux" ? `aux_${auxIndex}_state` : (heaterKind === "pool" ? "pool_heater" : "spa_heater");
      const cmd = action === "set-aux" ? `set_aux_${auxIndex}` : (heaterKind === "pool" ? "set_pool_heater" : "set_spa_heater");

      // Read current state
      const beforeRes = await withRelogin(supabase, (sid) => iaquaGetHome(home.iaqualink_serial, sid));
      if (beforeRes.status >= 400) {
        return new Response(JSON.stringify({ error: `get_home ${beforeRes.status}` }), {
          status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const flatten = (raw: any): Record<string, string> => {
        const flat: Record<string, string> = {};
        for (const row of (raw?.home_screen || [])) for (const [k, v] of Object.entries(row)) flat[k] = String(v);
        return flat;
      };
      const beforeFlat = flatten(beforeRes.body);
      const currentOn = beforeFlat[stateKey] === "1";
      let toggled = false;
      if (currentOn !== on) {
        const cmdRes = await withRelogin(supabase, (sid) => iaquaSendCommand(home.iaqualink_serial, sid, cmd));
        if (cmdRes.status >= 400) {
          return new Response(JSON.stringify({ error: `${cmd} ${cmdRes.status}: ${JSON.stringify(cmdRes.body)}` }), {
            status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        toggled = true;
        await new Promise((r) => setTimeout(r, 1500));
      }
      // Verify
      let verified = !toggled; // if no toggle needed, state already matches
      let finalState = currentOn;
      try {
        const after = await withRelogin(supabase, (sid) => iaquaGetHome(home.iaqualink_serial, sid));
        const afterFlat = flatten(after.body);
        finalState = afterFlat[stateKey] === "1";
        verified = finalState === on;
      } catch { /* ignore */ }
      return new Response(JSON.stringify({ success: true, verified, state_key: stateKey, state: finalState, toggled }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Return the list of toggleable items detected on this iAquaLink panel
    // (aux_N labels + heater states) so admin UI can build feature mapping
    // dropdowns. We derive the labels from the panel's one_touch / aux name
    // fields when present, otherwise fall back to "Aux N".
    if (action === "list-controls") {
      const { home_id } = body;
      if (!home_id) return new Response(JSON.stringify({ error: "home_id required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const { data: home } = await supabase.from("homes").select("*").eq("id", home_id).maybeSingle();
      if (!home?.iaqualink_serial) return new Response(JSON.stringify({ error: "Home has no iAquaLink serial" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const r = await withRelogin(supabase, (sid) => iaquaGetHome(home.iaqualink_serial, sid));
      if (r.status >= 400) return new Response(JSON.stringify({ error: `get_home ${r.status}` }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const flat: Record<string, string> = {};
      for (const row of ((r.body as any)?.home_screen || [])) for (const [k, v] of Object.entries(row)) flat[k] = String(v);
      const controls: Array<{ target: string; label: string; state?: string }> = [];
      for (let i = 1; i <= 7; i++) {
        const labelKey = `aux_${i}_label`;
        const stateKey = `aux_${i}_state`;
        if (flat[stateKey] != null || flat[labelKey]) {
          controls.push({ target: `aux:${i}`, label: flat[labelKey] || `Aux ${i}`, state: flat[stateKey] });
        }
      }
      if (flat.pool_heater != null) controls.push({ target: "heater:pool", label: "Pool Heater", state: flat.pool_heater });
      if (flat.spa_heater != null) controls.push({ target: "heater:spa", label: "Spa Heater", state: flat.spa_heater });
      return new Response(JSON.stringify({ success: true, controls }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("iaqualink-control error:", e);
    return new Response(JSON.stringify({ error: e.message || String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
