// تحويل الصوت لكتابة (عربي، كردي، إنكليزي...) بنموذج Whisper المجاني من Cloudflare
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "سجّل دخول أول" }, 401);
    const { audio, mime } = await req.json();
    if (!audio || audio.length > 12_000_000) return json({ error: "التسجيل طويل هواية، خلّيه أقل من دقيقتين" }, 400);

    const cfAcc = Deno.env.get("CF_ACCOUNT_ID"), cfTok = Deno.env.get("CF_API_TOKEN");
    const t = Date.now();
    if (cfAcc && cfTok) {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAcc}/ai/run/@cf/openai/whisper-large-v3-turbo`, {
        method: "POST", headers: { Authorization: `Bearer ${cfTok}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(45000),
        body: JSON.stringify({ audio, task: "transcribe", vad_filter: true }) }).catch(() => null);
      const j = r?.ok ? await r.json() : null;
      console.log("stt cloudflare", r?.status, Date.now() - t);
      const text = j?.result?.text?.trim();
      if (text) return json({ text });
      if (r && !r.ok) console.error("stt", (await r.text()).slice(0, 200));
    }
    // احتياط: Gemini يسمع الصوت
    const key = Deno.env.get("GEMINI_API_KEY");
    for (const m of ["gemini-3.5-flash-lite", "gemini-flash-latest"]) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key! },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ inline_data: { mime_type: mime || "audio/webm", data: audio } }, { text: "اكتب هذا الكلام حرفياً بنفس لغته ولهجته، بدون أي إضافة." }] }] }) }).catch(() => null);
      if (!r?.ok) continue;
      const text = (await r.json())?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("").trim();
      if (text) return json({ text });
    }
    return json({ error: "ما كدرت أسمع الصوت زين، جرّب مرة ثانية بمكان هادي" }, 503);
  } catch (e) {
    console.error(String(e));
    return json({ error: "صار خلل، جرّب مرة ثانية" }, 500);
  }
});
