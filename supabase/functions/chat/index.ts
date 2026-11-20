import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MODELS = (Deno.env.get("GEMINI_MODELS") ?? "gemini-2.5-flash,gemini-2.0-flash").split(",");

const PERSONA = `إنت "يار" (YAR AI)، مساعد ذكاء اصطناعي عراقي من صنع YAR Studio.
- تحچي باللهجة العراقية البيضاء بشكل طبيعي ومحترم، وتفهم العربي الفصيح والكردي والتركماني والإنكليزي. إذا المستخدم كتب بالكردي جاوبه بالكردي.
- تعرف العراق زين: المدن، العادات، المناسبات، الأكلات، والسوق المحلي.
- تساعد بكل أنواع الشغل: كتابة منشورات وكابشنات وإعلانات، أفكار تصاميم، شرح، تخطيط مشاريع، رسائل، دراسة.
- بالتصاميم: تقترح فكرة واضحة، نص الإعلان، الألوان، الترتيب، وبرومبت صورة مفصل بالإنكليزي إذا انطلب. الموديلات بالصور يكونون عراقيين أو كرد بلبس محلي.
- الدقة أهم شي: إذا ما متأكد من معلومة گول بصراحة "مو متأكد"، ولا تخترع أرقام أو أسماء أو مصادر.
- بالأمور الطبية والقانونية والمالية: تنطي معلومة عامة وتنصح بمراجعة مختص.
- الأجوبة مرتبة وبدون حشو.`;

const REVIEWER = `إنت مراجع جودة. راح توصلك رسالة المستخدم ومسودة الجواب.
افحص: أخطاء المعلومات، الأخطاء الإملائية والنحوية، هل جاوب على السؤال كامل، هل اللغة مناسبة لسؤال المستخدم.
إذا المسودة صحيحة رجّعها مثل ما هي. إذا بيها غلط صحّحه.
رجّع الجواب النهائي فقط، بدون أي تعليق منك.`;

async function gemini(system: string, contents: unknown[]) {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("NO_KEY");
  let lastErr = "";
  for (const model of MODELS) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model.trim()}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { temperature: 0.6 } }),
    });
    if (r.ok) {
      const j = await r.json();
      const t = j?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
      if (t.trim()) return t;
      lastErr = "empty";
    } else lastErr = `${r.status} ${await r.text()}`;
  }
  throw new Error(lastErr);
}

function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const url = Deno.env.get("SUPABASE_URL")!;
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "سجّل دخول أول" }, 401);

    const { conversation_id, message } = await req.json();
    const text = String(message ?? "").trim().slice(0, 8000);
    if (!text) return json({ error: "الرسالة فارغة" }, 400);

    const { data: planId } = await admin.rpc("effective_plan", { p_user: user.id });
    const { data: plan } = await admin.from("plans").select("*").eq("id", planId ?? "free").single();
    const limit = plan?.daily_limit ?? 15;

    const { data: used } = await admin.rpc("bump_usage", { p_user: user.id, p_limit: limit });
    if (used === -1) {
      return json({ error: `وصلت الحد اليومي لباقة ${plan?.name ?? "المجاني"} (${limit} رسالة). اشترك بباقة أعلى أو ارجع باچر.`, upgrade: true }, 429);
    }

    let convId = conversation_id;
    if (!convId) {
      const { data: c } = await admin.from("conversations").insert({ user_id: user.id, title: text.slice(0, 40) }).select("id").single();
      convId = c!.id;
    } else {
      const { data: c } = await admin.from("conversations").select("id").eq("id", convId).eq("user_id", user.id).maybeSingle();
      if (!c) return json({ error: "المحادثة مو موجودة" }, 404);
    }
    const { data: hist } = await admin.from("messages").select("role,content").eq("conversation_id", convId).order("created_at", { ascending: false }).limit(20);
    const contents = (hist ?? []).reverse().map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    contents.push({ role: "user", parts: [{ text }] });

    const draft = await gemini(PERSONA, contents);
    let final = draft;
    if (plan?.review) {
      try {
        final = await gemini(REVIEWER, [{ role: "user", parts: [{ text: `رسالة المستخدم:\n${text}\n\nالمسودة:\n${draft}` }] }]);
      } catch { final = draft; }
    }

    await admin.from("messages").insert([
      { conversation_id: convId, user_id: user.id, role: "user", content: text },
      { conversation_id: convId, user_id: user.id, role: "assistant", content: final },
    ]);
    await admin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", convId);
    return json({ conversation_id: convId, reply: final, remaining: limit - (used ?? 0), plan: plan?.id });
  } catch (e) {
    const m = String((e as Error).message);
    if (m === "NO_KEY") return json({ error: "مفتاح الذكاء الاصطناعي بعده ما انضاف" }, 503);
    console.error(m);
    return json({ error: "صار خلل مؤقت، جرّب مرة ثانية" }, 500);
  }
});
