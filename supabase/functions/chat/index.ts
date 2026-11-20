import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MODELS = (Deno.env.get("GEMINI_MODELS") ?? "gemini-3.5-flash,gemini-3.8-flash,gemini-flash-latest,gemini-3.5-flash-lite").split(",");
const HISTORY = 24;        // آخر رسائل تنرسل كاملة
const MAX_MEMORIES = 80;   // أقصى عدد معلومات محفوظة لكل مستخدم

const PERSONA = `إنت "يار" (YAR AI)، مساعد ذكاء اصطناعي عراقي من صنع YAR Studio.
- تحچي باللهجة العراقية البيضاء بشكل طبيعي ومحترم، وتفهم العربي الفصيح والكردي والتركماني والإنكليزي. إذا المستخدم كتب بالكردي جاوبه بالكردي. الكتابة الأكاديمية أو الرسمية تكون بالفصيح.
- تعرف العراق زين: المدن، العادات، المناسبات، الأكلات، الجامعات، والسوق المحلي.
- الدقة أهم شي: إذا ما متأكد من معلومة گول بصراحة "مو متأكد"، ولا تخترع أرقام أو أسماء أو مصادر.
- بالأمور الطبية والقانونية والمالية: تنطي معلومة عامة وتنصح بمراجعة مختص.
- استخدم اللي تعرفه عن المستخدم (من الذاكرة) بشكل طبيعي بدون ما تگول "حسب ذاكرتي".
- الأجوبة مرتبة وبدون حشو.`;

const REVIEWER = `إنت مراجع جودة. راح توصلك رسالة المستخدم ومسودة الجواب.
افحص: أخطاء المعلومات، الحسابات، المصادر المخترعة، الأخطاء الإملائية والنحوية، هل جاوب على السؤال كامل، هل اللغة مناسبة.
إذا المسودة صحيحة رجّعها مثل ما هي. إذا بيها غلط صحّحه.
رجّع الجواب النهائي فقط، بدون أي تعليق منك.`;

const EXTRACTOR = `استخرج من آخر رسالة للمستخدم معلومات ثابتة ومفيدة عنه للمستقبل: اسمه، دراسته أو تخصصه، جامعته، مرحلته، شغله، مدينته، مشاريعه وبحوثه الجارية، أدواته ولغاته البرمجية، تفضيلاته بطريقة الجواب.
لا تحفظ: الأسئلة العابرة، المعلومات الصحية أو المالية الحساسة، كلمات السر، أرقام الهويات والحسابات.
لا تكرر شي موجود بالقائمة الحالية. إذا معلومة جديدة تصحح قديمة، حط القديمة بـ remove.
رجّع JSON فقط بهذا الشكل: {"add":["جملة قصيرة"],"remove":["نص المعلومة القديمة حرفياً"]}`;

let LAST_SOURCES: { uri: string; title: string }[] = [];
async function gemini(system: string, contents: unknown[], jsonOut = false, search = false) {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("NO_KEY");
  let lastErr = "";
  const tries = MODELS.flatMap((m) => search ? [[m, true], [m, false]] : [[m, false]]) as [string, boolean][];
  for (const [model, useSearch] of tries) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model.trim()}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] }, contents,
        ...(useSearch ? { tools: [{ google_search: {} }] } : {}),
        generationConfig: { temperature: jsonOut ? 0.1 : 0.6, ...(jsonOut ? { responseMimeType: "application/json" } : {}) },
      }),
    });
    if (r.ok) {
      const j = await r.json();
      if (useSearch) LAST_SOURCES = (j?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []).map((c: { web?: { uri: string; title: string } }) => c.web).filter(Boolean).slice(0, 5);
      const t = j?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
      if (t.trim()) return t;
      lastErr = "empty";
    } else lastErr = `${r.status} ${await r.text()}`;
  }
  // احتياطي ١: OpenRouter بنماذج مجانية (يشتغل إذا انحط OPENROUTER_API_KEY)
  // احتياطي ٢: Groq (يشتغل إذا انحط GROQ_API_KEY)
  const msgs = [{ role: "system", content: system }, ...(contents as { role: string; parts: { text?: string }[] }[]).map((c) => ({
    role: c.role === "model" ? "assistant" : "user", content: c.parts.map((p) => p.text ?? "").join("\n") || "(ملف مرفق)" }))];
  const clean = (t: string) => jsonOut ? t.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "") : t;
  const ork = Deno.env.get("OPENROUTER_API_KEY");
  if (ork) {
    const orModels = (Deno.env.get("OPENROUTER_MODELS") ?? "deepseek/deepseek-chat-v3-0324:free,meta-llama/llama-3.3-70b-instruct:free,qwen/qwen3-235b-a22b:free,openrouter/free").split(",");
    for (const m of orModels) {
      try {
        const r = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ork}`, "HTTP-Referer": "https://abdperfusion-svg.github.io/yar-ai/", "X-Title": "YAR AI" },
          body: JSON.stringify({ model: m.trim(), messages: msgs, temperature: jsonOut ? 0.1 : 0.6 }) });
        if (r.ok) { const j = await r.json(); const t = j?.choices?.[0]?.message?.content ?? ""; if (t.trim()) return clean(t); lastErr += ` | or ${m} empty`; }
        else lastErr += ` | or ${m} ${r.status}`;
      } catch (e) { lastErr += ` | or ${m} ${e}`; }
    }
  }
  const gk = Deno.env.get("GROQ_API_KEY");
  if (gk) {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${gk}` },
      body: JSON.stringify({ model: Deno.env.get("GROQ_MODEL") ?? "llama-3.3-70b-versatile", messages: msgs, temperature: jsonOut ? 0.1 : 0.6, ...(jsonOut ? { response_format: { type: "json_object" } } : {}) }) });
    if (r.ok) { const j = await r.json(); const t = j?.choices?.[0]?.message?.content ?? ""; if (t.trim()) return t; }
    else lastErr += ` | groq ${r.status}`;
  }
  throw new Error(lastErr);
}

function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
}

// deno-lint-ignore no-explicit-any
async function afterReply(admin: any, userId: string, convId: string, category: string, text: string, mems: { id: string; fact: string }[]) {
  // ١) ذاكرة طويلة: استخراج معلومات جديدة عن المستخدم
  try {
    const out = await gemini(EXTRACTOR, [{ role: "user", parts: [{ text: `القائمة الحالية:\n${mems.map((m) => "- " + m.fact).join("\n") || "(فارغة)"}\n\nرسالة المستخدم:\n${text}` }] }], true);
    const { add = [], remove = [] } = JSON.parse(out);
    const del = mems.filter((m) => (remove as string[]).includes(m.fact)).map((m) => m.id);
    if (del.length) await admin.from("memories").delete().in("id", del);
    const rows = (add as string[]).filter((f) => typeof f === "string" && f.trim().length > 3).slice(0, 5)
      .map((f) => ({ user_id: userId, fact: f.trim().slice(0, 300), category }));
    if (rows.length) await admin.from("memories").insert(rows);
    const { data: all } = await admin.from("memories").select("id").eq("user_id", userId).order("created_at", { ascending: false });
    if (all && all.length > MAX_MEMORIES) await admin.from("memories").delete().in("id", all.slice(MAX_MEMORIES).map((r: { id: string }) => r.id));
  } catch (e) { console.error("memory", String(e)); }

  // ٢) ملخص متجدد للمحادثات الطويلة حتى ما ينسى بدايتها
  try {
    const { count } = await admin.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", convId);
    if ((count ?? 0) > HISTORY && (count ?? 0) % 8 === 0) {
      const { data: conv } = await admin.from("conversations").select("summary").eq("id", convId).single();
      const { data: old } = await admin.from("messages").select("role,content").eq("conversation_id", convId)
        .order("created_at", { ascending: true }).limit((count ?? 0) - HISTORY);
      const transcript = (old ?? []).map((m: { role: string; content: string }) => `${m.role === "user" ? "المستخدم" : "يار"}: ${m.content.slice(0, 1500)}`).join("\n");
      const s = await gemini("لخّص المحادثة بنقاط مركزة تحفظ كل القرارات والمعلومات والأرقام المهمة وما تم الاتفاق عليه، بحدود ٢٥٠ كلمة.",
        [{ role: "user", parts: [{ text: `الملخص السابق:\n${conv?.summary ?? "لا يوجد"}\n\nالرسائل:\n${transcript}` }] }]);
      await admin.from("conversations").update({ summary: s }).eq("id", convId);
    }
  } catch (e) { console.error("summary", String(e)); }
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

    const { conversation_id, message, category, files } = await req.json();
    const text = String(message ?? "").trim().slice(0, 12000);
    if (!text && !(Array.isArray(files) && files.length)) return json({ error: "الرسالة فارغة" }, 400);

    const { data: planId } = await admin.rpc("effective_plan", { p_user: user.id });
    const { data: plan } = await admin.from("plans").select("*").eq("id", planId ?? "free").single();
    const limit = plan?.daily_limit ?? 15;
    const { data: used } = await admin.rpc("bump_usage", { p_user: user.id, p_limit: limit });
    if (used === -1) {
      return json({ error: `وصلت الحد اليومي لباقة ${plan?.name ?? "المجاني"} (${limit} رسالة). اشترك بباقة أعلى أو ارجع باچر.`, upgrade: true }, 429);
    }

    let convId = conversation_id, cat = "general", summary: string | null = null;
    if (!convId) {
      const { data: okCat } = await admin.from("categories").select("id").eq("id", category ?? "general").maybeSingle();
      cat = okCat?.id ?? "general";
      const { data: c } = await admin.from("conversations").insert({ user_id: user.id, title: (text || "📎 ملف").slice(0, 40), category: cat }).select("id").single();
      convId = c!.id;
    } else {
      const { data: c } = await admin.from("conversations").select("id,category,summary").eq("id", convId).eq("user_id", user.id).maybeSingle();
      if (!c) return json({ error: "المحادثة مو موجودة" }, 404);
      cat = c.category; summary = c.summary;
    }

    const [{ data: catRow }, { data: mems }, { data: hist }, { data: prof }] = await Promise.all([
      admin.from("categories").select("name,prompt").eq("id", cat).single(),
      admin.from("memories").select("id,fact").eq("user_id", user.id).order("created_at", { ascending: false }).limit(MAX_MEMORIES),
      admin.from("messages").select("role,content").eq("conversation_id", convId).order("created_at", { ascending: false }).limit(HISTORY),
      admin.from("profiles").select("full_name,specialty,institution,stage,city,about").eq("user_id", user.id).maybeSingle(),
    ]);

    let system = PERSONA;
    if (catRow?.prompt) system += `\n\n${catRow.prompt}`;
    if (prof) {
      const lines = [["الاسم", prof.full_name], ["التخصص أو الشغل", prof.specialty], ["الجامعة أو مكان العمل", prof.institution], ["المرحلة أو الخبرة", prof.stage], ["المدينة", prof.city], ["عن نفسه", prof.about]]
        .filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`);
      if (lines.length) system += `\n\nملف المستخدم الشخصي (هو كتبه بنفسه، ناديه باسمه):\n${lines.join("\n")}`;
    }
    if (mems?.length) system += `\n\nاللي تعرفه عن هذا المستخدم:\n${mems.map((m) => "- " + m.fact).join("\n")}`;
    if (summary) system += `\n\nملخص بداية هذي المحادثة:\n${summary}`;

    const contents = (hist ?? []).reverse().map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    const att = (Array.isArray(files) ? files : []).slice(0, 4).filter((f: { mime?: string; data?: string }) => f?.mime && f?.data && f.data.length < 11_000_000);
    contents.push({ role: "user", parts: [...att.map((f: { mime: string; data: string }) => ({ inline_data: { mime_type: f.mime, data: f.data } })), { text: text || "حلل هذا الملف" }] });

    LAST_SOURCES = [];
    const draft = await gemini(system + `\n\nتاريخ اليوم: ${new Date().toISOString().slice(0, 10)}. إذا السؤال يحتاج معلومات حديثة (أسعار، أخبار، أحداث، أشياء تتغير) استخدم بحث Google.`, contents, false, true);
    const sources = LAST_SOURCES;
    let final = draft;
    if (plan?.review) {
      try {
        final = await gemini(REVIEWER, [{ role: "user", parts: [{ text: `الفئة: ${catRow?.name}\nرسالة المستخدم:\n${text}\n\nالمسودة:\n${draft}` }] }]);
      } catch { final = draft; }
    }

    if (sources.length) final += `\n\n**المصادر:**\n${sources.map((x) => `- [${x.title}](${x.uri})`).join("\n")}`;
    const shown = att.length ? `📎 ${att.map((f: { name?: string }) => f.name || "ملف").join("، ")}\n${text}` : text;
    await admin.from("messages").insert([
      { conversation_id: convId, user_id: user.id, role: "user", content: shown },
      { conversation_id: convId, user_id: user.id, role: "assistant", content: final },
    ]);
    await admin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", convId);

    // الذاكرة والملخص يشتغلون بالخلفية حتى ما يتأخر الجواب
    if (text) EdgeRuntime.waitUntil(afterReply(admin, user.id, convId, cat, text, mems ?? []));

    return json({ conversation_id: convId, category: cat, reply: final, remaining: limit - (used ?? 0), plan: plan?.id });
  } catch (e) {
    const m = String((e as Error).message);
    if (m === "NO_KEY") return json({ error: "مفتاح الذكاء الاصطناعي بعده ما انضاف" }, 503);
    console.error(m);
    return json({ error: "صار خلل مؤقت، جرّب مرة ثانية" }, 500);
  }
});
