import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ربط حسابات المستخدم بماجنيفيك و Higgsfield (نفس طريقة موصّلات Claude: OAuth + MCP)
// الصور تتولّد بحساب المستخدم ومن رصيده هو.
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-yar-internal", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const T = (ms: number) => AbortSignal.timeout(ms);
const APP = "https://abdperfusion-svg.github.io/yar-ai/";
const SELF = `${Deno.env.get("SUPABASE_URL")}/functions/v1/mcp-link`;
const SERVERS: Record<string, { url: string; label: string }> = {
  magnific: { url: "https://mcp.magnific.com", label: "ماجنيفيك" },
  higgsfield: { url: "https://mcp.higgsfield.ai/mcp", label: "Higgsfield" },
};
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const rand = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s: string) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
const getJ = async (u: string) => { try { const r = await fetch(u, { signal: T(10000), headers: { Accept: "application/json" } }); return r.ok ? await r.json() : null; } catch { return null; } };

// نكتشف سيرفر تسجيل الدخول ونسجّل يار كتطبيق (مرة وحدة لكل موقع)
async function client(provider: string) {
  const { data: c } = await admin.from("mcp_clients").select("*").eq("provider", provider).maybeSingle();
  if (c && c.redirect_uri === SELF) return c;
  const srv = new URL(SERVERS[provider].url);
  const prm = await getJ(`${srv.origin}/.well-known/oauth-protected-resource${srv.pathname === "/" ? "" : srv.pathname}`) ?? await getJ(`${srv.origin}/.well-known/oauth-protected-resource`);
  const as = new URL(prm?.authorization_servers?.[0] ?? srv.origin);
  const p = as.pathname === "/" ? "" : as.pathname;
  const meta = await getJ(`${as.origin}/.well-known/oauth-authorization-server${p}`) ?? await getJ(`${as.origin}${p}/.well-known/openid-configuration`)
    ?? await getJ(`${as.origin}/.well-known/openid-configuration${p}`) ?? await getJ(`${srv.origin}/.well-known/oauth-authorization-server`);
  if (!meta?.authorization_endpoint || !meta?.token_endpoint || !meta?.registration_endpoint) throw new Error("discovery failed");
  const reg = await fetch(meta.registration_endpoint, { method: "POST", signal: T(15000), headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "YAR AI", redirect_uris: [SELF], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", client_uri: APP }) });
  if (!reg.ok) throw new Error(`register ${reg.status} ${(await reg.text()).slice(0, 200)}`);
  const rj = await reg.json();
  const row = { provider, client_id: rj.client_id, client_secret: rj.client_secret ?? null, auth_ep: meta.authorization_endpoint, token_ep: meta.token_endpoint,
    scope: (prm?.scopes_supported ?? meta.scopes_supported ?? []).filter((s: string) => !/^(openid)$/.test(s)).join(" ") || null, redirect_uri: SELF };
  await admin.from("mcp_clients").upsert(row);
  return row;
}

async function tokenReq(c: Record<string, string>, form: Record<string, string>) {
  const body = new URLSearchParams({ client_id: c.client_id, ...(c.client_secret ? { client_secret: c.client_secret } : {}), ...form });
  const r = await fetch(c.token_ep, { method: "POST", signal: T(15000), headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body });
  if (!r.ok) throw new Error(`token ${r.status} ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

async function accessToken(userId: string, provider: string): Promise<string | null> {
  const { data: u } = await admin.from("user_connections").select("id,access_token,refresh_token,expires_at").eq("user_id", userId).eq("provider", provider).maybeSingle();
  if (!u) return null;
  if (u.access_token && (!u.expires_at || new Date(u.expires_at).getTime() > Date.now() + 60_000)) return u.access_token;
  if (!u.refresh_token) return u.access_token;
  try {
    const c = await client(provider);
    const t = await tokenReq(c, { grant_type: "refresh_token", refresh_token: u.refresh_token, resource: SERVERS[provider].url });
    await admin.from("user_connections").update({ access_token: t.access_token, refresh_token: t.refresh_token ?? u.refresh_token, expires_at: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null, updated_at: new Date().toISOString() }).eq("id", u.id);
    return t.access_token;
  } catch (e) { console.error("refresh", provider, String(e)); return null; }
}

// ===== التخاطب ويا سيرفر MCP =====
async function rpc(url: string, token: string, sid: string | null, msg: Record<string, unknown>) {
  const r = await fetch(url, { method: "POST", signal: T(70000), headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18", ...(sid ? { "Mcp-Session-Id": sid } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", ...msg }) });
  if (r.status === 401) throw new Error("UNAUTH");
  const nsid = r.headers.get("mcp-session-id") ?? sid;
  if (!("id" in msg)) { await r.text().catch(() => ""); return { sid: nsid, res: null }; }
  if (!r.ok) throw new Error(`mcp ${r.status} ${(await r.text()).slice(0, 200)}`);
  const ct = r.headers.get("content-type") ?? "";
  if (ct.includes("event-stream")) {
    const txt = await r.text();
    for (const line of txt.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try { const j = JSON.parse(line.slice(5)); if (j.id === msg.id) return { sid: nsid, res: j }; } catch { /* */ }
    }
    throw new Error("no response");
  }
  return { sid: nsid, res: await r.json() };
}
async function mcpSession(provider: string, token: string) {
  const url = SERVERS[provider].url;
  const a = await rpc(url, token, null, { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "YAR AI", version: "1.0" } } });
  await rpc(url, token, a.sid, { method: "notifications/initialized" });
  let n = 2;
  return async (name: string, args: Record<string, unknown>) => {
    const { res } = await rpc(url, token, a.sid, { id: n++, method: "tools/call", params: { name, arguments: args } });
    if (res?.error) throw new Error(`tool ${name}: ${JSON.stringify(res.error).slice(0, 200)}`);
    const r = res?.result ?? {};
    if (r.structuredContent) return r.structuredContent;
    const t = (r.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n");
    try { return JSON.parse(t); } catch { return { text: t, isError: r.isError }; }
  };
}

// نلگط المعرّفات والروابط من أي شكل جواب
function findAll(o: unknown, test: (k: string, v: string) => boolean, out: string[] = []): string[] {
  if (Array.isArray(o)) o.forEach((x) => findAll(x, test, out));
  else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { if (typeof v === "string" && test(k, v)) out.push(v); else findAll(v, test, out); }
  return out;
}
const imgUrl = (o: unknown) => findAll(o, (k, v) => /^https:\/\//.test(v) && (/\.(png|jpe?g|webp)(\?|$)/i.test(v) || /(url|download|image|src|preview)/i.test(k)) && !/thumb|avatar|icon/i.test(k + v))[0] ?? null;

async function generate(provider: string, call: Awaited<ReturnType<typeof mcpSession>>, prompt: string, aspect: string) {
  if (provider === "magnific") {
    const g = await call("images_generate", { prompt, aspectRatio: aspect || "auto", mode: "auto", count: 1 });
    let url = imgUrl(g);
    const ids = [...new Set(findAll(g, (k) => /identifier$|^id$|creationId/i.test(k)))].slice(0, 2);
    for (let i = 0; !url && ids.length && i < 3; i++) { const w = await call("creations_wait", { creationIdentifiers: ids, timeoutSeconds: 45 }); url = imgUrl(w); if (findAll(w, (k, v) => /status/i.test(k) && /fail|error/i.test(v)).length) break; }
    return url;
  }
  const g = await call("generate_image", { params: { model: Deno.env.get("HF_LINK_MODEL") ?? "soul_2", prompt, aspect_ratio: aspect || "1:1", count: 1, use_unlim: false } });
  let url = imgUrl(g);
  const jobs = [...new Set(findAll(g, (k, v) => /job_?id|^id$/i.test(k) && /^[0-9a-f-]{36}$/i.test(v)))].slice(0, 1);
  for (let i = 0; !url && jobs.length && i < 5; i++) { const w = await call("jobs_wait", { jobs: [{ index: 0, job_id: jobs[0] }], timeout_seconds: 15 }); url = imgUrl(w); if (findAll(w, (k, v) => /status/i.test(k) && /fail|nsfw|error/i.test(v)).length) break; }
  return url;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const q = new URL(req.url).searchParams;
  try {
    // رجوع من صفحة تسجيل الدخول
    if (req.method === "GET" && q.get("state")) {
      const { data: st } = await admin.from("mcp_states").select("*").eq("state", q.get("state")).maybeSingle();
      if (!st || Date.now() - new Date(st.created_at).getTime() > 15 * 60_000) return Response.redirect(`${APP}?connect_error=expired`, 302);
      await admin.from("mcp_states").delete().eq("state", st.state);
      if (!q.get("code")) return Response.redirect(`${APP}?connect_error=cancel`, 302);
      const c = await client(st.provider);
      const t = await tokenReq(c, { grant_type: "authorization_code", code: q.get("code")!, redirect_uri: SELF, code_verifier: st.verifier, resource: SERVERS[st.provider].url });
      await admin.from("user_connections").upsert({ user_id: st.user_id, provider: st.provider, account_label: SERVERS[st.provider].label, access_token: t.access_token, refresh_token: t.refresh_token ?? null,
        expires_at: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null, scopes: t.scope ?? null, updated_at: new Date().toISOString() }, { onConflict: "user_id,provider" });
      return Response.redirect(`${APP}?connected=${st.provider}`, 302);
    }

    const body = await req.json().catch(() => ({}));
    // نداء داخلي من دالة الصور (بمفتاح السيرفر)
    let userId: string | null = null;
    if (req.headers.get("x-yar-internal") === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) userId = body.user_id;
    else {
      const uc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
      userId = (await uc.auth.getUser()).data.user?.id ?? null;
    }
    if (!userId) return json({ error: "سجّل دخول أول" }, 401);
    const provider = String(body.provider ?? "magnific");
    if (!SERVERS[provider]) return json({ error: "bad provider" }, 400);

    if (body.action === "start") {
      const c = await client(provider);
      const state = rand(24), verifier = rand(48);
      await admin.from("mcp_states").insert({ state, user_id: userId, provider, verifier });
      const u = new URL(c.auth_ep);
      Object.entries({ response_type: "code", client_id: c.client_id, redirect_uri: SELF, state, code_challenge: await sha256(verifier), code_challenge_method: "S256", resource: SERVERS[provider].url, ...(c.scope ? { scope: c.scope } : {}) })
        .forEach(([k, v]) => u.searchParams.set(k, v as string));
      return json({ url: u.toString() });
    }

    const token = await accessToken(userId, provider);
    if (!token) return json({ error: "الحساب مو مربوط أو انتهى الربط. اربطه من جديد من «حساباتي المربوطة».", relink: true }, 401);
    const call = await mcpSession(provider, token);

    if (body.action === "balance") {
      const b = await call(provider === "magnific" ? "account_balance" : "balance", {});
      return json({ balance: b });
    }
    if (body.action === "generate") {
      const src = await generate(provider, call, String(body.prompt ?? "").slice(0, 1500), String(body.aspect ?? ""));
      if (!src) return json({ error: "ما طلعت صورة من حسابك (يمكن خلص رصيدك اليومي)" }, 502);
      const f = await fetch(src, { signal: T(40000) });
      if (!f.ok) return json({ error: "ما كدرت أنزّل الصورة" }, 502);
      const bytes = new Uint8Array(await f.arrayBuffer());
      const ct = f.headers.get("content-type") ?? "image/png";
      const path = `${userId}/${crypto.randomUUID()}.${ct.includes("jpeg") ? "jpg" : ct.includes("webp") ? "webp" : "png"}`;
      const up = await admin.storage.from("images").upload(path, bytes, { contentType: ct.startsWith("image/") ? ct : "image/png" });
      if (up.error) return json({ error: "ما انحفظت" }, 500);
      return json({ image: admin.storage.from("images").getPublicUrl(path).data.publicUrl });
    }
    return json({ error: "bad" }, 400);
  } catch (e) {
    const m = String((e as Error).message);
    console.error("mcp-link", m);
    if (m === "UNAUTH") return json({ error: "انتهى ربط الحساب. اربطه من جديد من «حساباتي المربوطة».", relink: true }, 401);
    if (req.method === "GET") return Response.redirect(`${APP}?connect_error=fail`, 302);
    return json({ error: "صار خلل بالربط، جرّب مرة ثانية" }, 500);
  }
});
