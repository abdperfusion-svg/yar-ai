// ربط حسابات المستخدم (جوجل درايف وجيميل، نوشن، كانفا) — OAuth
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const APP = Deno.env.get("APP_URL") ?? "https://abdperfusion-svg.github.io/yar-ai/";
const FN = `${Deno.env.get("SUPABASE_URL")}/functions/v1/connect`;
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const back = (q: string) => Response.redirect(`${APP}?${q}`, 302);

const PROVIDERS: Record<string, { auth: string; token: string; scope: string; id: string; secret: string; extra?: Record<string, string>; basic?: boolean; pkce?: boolean }> = {
  google: {
    auth: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token",
    scope: "openid email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
    id: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET", extra: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
  },
  notion: { auth: "https://api.notion.com/v1/oauth/authorize", token: "https://api.notion.com/v1/oauth/token", scope: "", id: "NOTION_CLIENT_ID", secret: "NOTION_CLIENT_SECRET", extra: { owner: "user" }, basic: true },
  canva: {
    auth: "https://www.canva.com/api/oauth/authorize", token: "https://api.canva.com/rest/v1/oauth/token",
    scope: "design:content:write design:content:read design:meta:read asset:write asset:read profile:read", id: "CANVA_CLIENT_ID", secret: "CANVA_CLIENT_SECRET", basic: true, pkce: true,
  },
};

// توقيع الحالة حتى ما أحد يزوّر الربط
const enc = new TextEncoder();
async function hmac(s: string) {
  const k = await crypto.subtle.importKey("raw", enc.encode(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(s))))).replace(/[+/=]/g, "").slice(0, 32);
}
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // ١) البرنامج يطلب رابط الربط
  if (req.method === "POST") {
    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "سجّل دخول أول" }, 401);
    const { provider } = await req.json();
    const p = PROVIDERS[provider];
    if (!p) return json({ error: "خدمة غير معروفة" }, 400);
    const cid = Deno.env.get(p.id);
    if (!cid) return json({ error: "هاي الخدمة بعدها ما تفعّلت، قريباً إن شاء الله" }, 503);
    const payload = `${user.id}.${provider}.${Date.now()}`;
    let verifier = "";
    const q = new URLSearchParams({ client_id: cid, redirect_uri: FN, response_type: "code", ...(p.scope ? { scope: p.scope } : {}), ...(p.extra ?? {}) });
    if (p.pkce) {
      verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
      q.set("code_challenge", b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier)))));
      q.set("code_challenge_method", "S256");
    }
    const st = `${payload}.${verifier}`;
    q.set("state", `${btoa(st)}~${await hmac(st)}`);
    return json({ url: `${p.auth}?${q}` });
  }

  // ٢) رجوع من صفحة الموافقة
  const code = url.searchParams.get("code"), state = url.searchParams.get("state");
  if (url.searchParams.get("error")) return back("connect_error=cancel");
  if (!code || !state) return back("connect_error=bad");
  const [raw, sig] = state.split("~");
  let st = "";
  try { st = atob(raw); } catch { return back("connect_error=bad"); }
  if (sig !== await hmac(st)) return back("connect_error=bad");
  const [uid, provider, ts, verifier] = st.split(".");
  if (Date.now() - Number(ts) > 15 * 60_000) return back("connect_error=expired");
  const p = PROVIDERS[provider];
  if (!p) return back("connect_error=bad");
  const cid = Deno.env.get(p.id)!, sec = Deno.env.get(p.secret)!;

  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: FN });
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (p.basic) headers.Authorization = `Basic ${btoa(`${cid}:${sec}`)}`; else { body.set("client_id", cid); body.set("client_secret", sec); }
  if (verifier) body.set("code_verifier", verifier);
  const r = await fetch(p.token, { method: "POST", headers, body: provider === "notion" ? JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: FN }) : body,
    ...(provider === "notion" ? { headers: { ...headers, "Content-Type": "application/json" } } : {}) });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) { console.error("token", provider, r.status, JSON.stringify(t).slice(0, 300)); return back("connect_error=token"); }

  let label = "";
  try {
    if (provider === "google") label = (await (await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${t.access_token}` } })).json()).email ?? "";
    if (provider === "notion") label = t.workspace_name ?? "Notion";
    if (provider === "canva") label = (await (await fetch("https://api.canva.com/rest/v1/users/me/profile", { headers: { Authorization: `Bearer ${t.access_token}` } })).json())?.profile?.display_name ?? "Canva";
  } catch { /* */ }

  await admin.from("user_connections").upsert({
    user_id: uid, provider, account_label: label, access_token: t.access_token, refresh_token: t.refresh_token ?? null,
    expires_at: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null, scopes: t.scope ?? p.scope, updated_at: new Date().toISOString(),
  }, { onConflict: "user_id,provider" });
  return back(`connected=${provider}`);
});
