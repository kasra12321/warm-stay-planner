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
    const isServiceRole = token === serviceKey;

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
      return new Response(JSON.stringify({ success: true, result: res.body }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
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
      return new Response(JSON.stringify({ success: true, status: flat, raw: res.body }), {
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
