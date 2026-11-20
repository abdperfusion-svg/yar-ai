import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// اقتراحات أول الشاشة حسب شغل المستخدم وتخصصه (ما تنحسب من رصيد الرسائل)
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const MODELS = (Deno.env.get("GEMINI_MODELS") ?? "gemini-3.5-flash,gemini-3.8-flash,gemini-flash-latest,gemini-3.5-flash-lite").split(",");
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "auth" }, 401);
    const { data: p } = await userClient.from("profiles").select("full_name,specialty,institution,stage,city,about,category").eq("user_id", user.id).maybeSingle();
    if (!p?.specialty && !p?.about) return json({ items: [] });

    const sys = `إنت تقترح ٦ طلبات مفيدة جداً يگدر هذا الشخص يطلبها من مساعد ذكاء اصطناعي اسمه "يار"، حسب شغله وتخصصه ومرحلته بالضبط.
- كل اقتراح شغلة حقيقية يحتاجها يومياً بشغله أو دراسته (مثلاً للممرض: خطة رعاية، جرعات وحسابات، تثقيف مريض، تقرير شفت).
- نوّع: كتابة، تعلم، حسابات، تنظيم، تواصل. لا تكرر.
- label قصير (٢-٤ كلمات) باللهجة العراقية، prompt طلب كامل وواضح باللهجة العراقية (جملة أو جملتين) يگدر يرسله مباشرة.
- icon إيموجي واحد مناسب.
رجّع JSON فقط: {"items":[{"icon":"🩺","label":"...","prompt":"..."}]}`;
    const info = `الشغل/التخصص: ${p.specialty ?? "-"}\nالمكان: ${p.institution ?? "-"}\nالمرحلة/الخبرة: ${p.stage ?? "-"}\nالمدينة: ${p.city ?? "-"}\nعنه: ${p.about ?? "-"}`;
    const key = Deno.env.get("GEMINI_API_KEY")!;
    for (const m of MODELS) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m.trim()}:generateContent`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents: [{ role: "user", parts: [{ text: info }] }], generationConfig: { temperature: 0.8, responseMimeType: "application/json" } }),
      }).catch(() => null);
      if (!r?.ok) continue;
      const t = (await r.json())?.candidates?.[0]?.content?.parts?.map((x: { text?: string }) => x.text ?? "").join("") ?? "";
      try {
        const items = (JSON.parse(t).items ?? []).filter((x: { label?: string; prompt?: string }) => x?.label && x?.prompt).slice(0, 6)
          .map((x: { icon?: string; label: string; prompt: string }) => ({ icon: String(x.icon ?? "✨").slice(0, 4), label: String(x.label).slice(0, 40), prompt: String(x.prompt).slice(0, 400) }));
        if (items.length) return json({ items });
      } catch { /* نجرب النموذج اللي بعده */ }
    }
    return json({ items: [] });
  } catch (e) {
    console.error(String(e));
    return json({ items: [] });
  }
});
