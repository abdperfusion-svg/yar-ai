import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const TEXT_MODELS = ["gemini-3.5-flash-lite", ...(Deno.env.get("GEMINI_MODELS") ?? "gemini-3.5-flash,gemini-flash-latest").split(",")];
const IMG_MODELS = (Deno.env.get("GEMINI_IMAGE_MODELS") ?? "gemini-3.1-flash-image,gemini-2.5-flash-image").split(",");
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const T = (ms: number) => AbortSignal.timeout(ms);

const PROMPTER = `You turn a user's image request (often Iraqi Arabic or Kurdish) into one excellent English prompt for an AI image model.
Rules: describe subject, setting, composition, lighting, style, camera/lens if photographic, colours, mood. Photorealistic unless the user asks for another style.
People: Iraqi or Kurdish looking, local styling. Iraqi men wear Iraqi dress (shemagh wrapped as jarawiya, striped zboun with sitra jacket, or modern clothes) never Gulf agal or white Gulf dishdasha. Kurdish context means Kurdish clothing.
If the user wants text in the image, put the exact text in quotes. No nudity, no real public figures, no brand logos.
Return JSON only: {"prompt":"...","aspect":"1:1|4:5|9:16|16:9","caption":"one short Iraqi-Arabic sentence describing exactly what was drawn"}`;

async function gemText(system: string, text: string) {
  // ١) Cloudflare (رصيد مجاني منفصل عن Google وسريع)
  const cfAcc = Deno.env.get("CF_ACCOUNT_ID"), cfTok = Deno.env.get("CF_API_TOKEN");
  if (cfAcc && cfTok) {
    const t = Date.now();
    try {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAcc}/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast`, {
        method: "POST", headers: { Authorization: `Bearer ${cfTok}`, "Content-Type": "application/json" }, signal: T(15000),
        body: JSON.stringify({ messages: [{ role: "system", content: system }, { role: "user", content: text }], max_tokens: 600, temperature: 0.7 }) });
      const j = r.ok ? await r.json() : null;
      let out = j?.result?.response;
      if (out && typeof out !== "string") out = JSON.stringify(out);
      console.log("prompt-model cloudflare", r.status, Date.now() - t);
      if (out) { const m = String(out).match(/\{[\s\S]*\}/); if (m) { JSON.parse(m[0]); return m[0]; } }
    } catch (e) { console.error("prompt cloudflare", String(e)); }
  }
  // ٢) Google احتياط
  const key = Deno.env.get("GEMINI_API_KEY")!;
  for (const m of TEXT_MODELS) {
    // بدون «تفكير»: وصف الصورة شغلة بسيطة وما تحتاج انتظار
    for (const think of [{ thinkingConfig: { thinkingBudget: 0 } }, {}]) {
      const t = Date.now();
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m.trim()}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, signal: T(8000),
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text }] }], generationConfig: { temperature: 0.7, responseMimeType: "application/json", ...think } }) }).catch(() => null);
      console.log("prompt-model", m, Object.keys(think).length ? "nothink" : "think", r?.status, Date.now() - t);
      if (r?.ok) { const j = await r.json(); const out = j?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join(""); if (out) return out; }
      if (r?.status !== 400) break; // 400 = النموذج ما يقبل إيقاف التفكير، نجرب بدونه
    }
  }
  throw new Error("prompt failed");
}

async function gemImage(prompt: string, aspect: string): Promise<Uint8Array | null> {
  const key = Deno.env.get("GEMINI_API_KEY")!;
  for (const m of IMG_MODELS) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m.trim()}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, signal: T(60000),
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: aspect } } }) }).catch(() => null);
    if (!r?.ok) { console.error("gemini-image", m, r?.status); continue; }
    const j = await r.json();
    const part = (j?.candidates?.[0]?.content?.parts ?? []).find((p: { inlineData?: { data: string } }) => p.inlineData);
    if (part) return Uint8Array.from(atob(part.inlineData.data), (c) => c.charCodeAt(0));
  }
  return null;
}

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// تعديل صورة المستخدم: جوجل أول (أذكى)، وبعدها كلاودفلير (يحافظ على شكل الصورة ويغيّر الستايل)
async function editImage(ref: { mime: string; data: string }, instruction: string, prompt: string): Promise<Uint8Array | null> {
  const key = Deno.env.get("GEMINI_API_KEY")!;
  for (const m of IMG_MODELS) {
    const t = Date.now();
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m.trim()}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, signal: T(60000),
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ inline_data: { mime_type: ref.mime, data: ref.data } }, { text: `Edit this image: ${instruction}\nKeep the same person/subject, face and pose. ${prompt}` }] }], generationConfig: { responseModalities: ["IMAGE"] } }) }).catch(() => null);
    console.log("edit-gemini", m, r?.status, Date.now() - t);
    if (!r?.ok) { if (r?.status === 429) break; continue; }
    const j = await r.json();
    const part = (j?.candidates?.[0]?.content?.parts ?? []).find((p: { inlineData?: { data: string } }) => p.inlineData);
    if (part) return b64(part.inlineData.data);
  }
  const cfAcc = Deno.env.get("CF_ACCOUNT_ID"), cfTok = Deno.env.get("CF_API_TOKEN");
  if (cfAcc && cfTok) {
    const t = Date.now();
    for (const model of ["@cf/black-forest-labs/flux-2-klein-4b", "@cf/black-forest-labs/flux-2-klein-9b", "@cf/black-forest-labs/flux-2-dev"]) {
      try {
        const form = new FormData();
        form.append("prompt", `Restyle image 0: ${instruction}. Keep the same subject, face, pose and composition. ${prompt}`.slice(0, 1500));
        form.append("input_image_0", new Blob([b64(ref.data)], { type: ref.mime || "image/jpeg" }), "input.jpg");
        const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAcc}/ai/run/${model}`, {
          method: "POST", headers: { Authorization: `Bearer ${cfTok}` }, signal: T(60000), body: form });
        console.log("edit-cloudflare", model, r.status, Date.now() - t);
        if (r.ok) {
          const ct = r.headers.get("content-type") ?? "";
          if (ct.startsWith("image/")) return new Uint8Array(await r.arrayBuffer());
          const j = await r.json(); const im = j?.result?.image; if (im) return b64(im);
        } else console.error("edit-cloudflare", model, (await r.text()).slice(0, 250));
      } catch (e) { console.error("edit-cloudflare", model, String(e)); }
    }
  }
  return null;
}
async function asImage(r: Response | null): Promise<Uint8Array | null> {
  if (!r?.ok) return null;
  const type = r.headers.get("content-type") ?? "";
  if (!type.startsWith("image/")) return null;
  const bytes = new Uint8Array(await r.arrayBuffer());
  return bytes.length > 20_000 ? bytes : null;
}

// الصور المجانية: نجرّب أكثر من مزوّد بسرعة، وكل وحدة بوقت محدد حتى ما يعلّق المستخدم
async function freeImage(prompt: string, w: number, h: number): Promise<Uint8Array | null> {
  const p = prompt.slice(0, 900), seed = Math.floor(Math.random() * 1e9);

  // ١) Cloudflare Workers AI (مجاني يومياً) — يشتغل إذا انحط CF_ACCOUNT_ID و CF_API_TOKEN
  const cfAcc = Deno.env.get("CF_ACCOUNT_ID"), cfTok = Deno.env.get("CF_API_TOKEN");
  if (cfAcc && cfTok) {
    try {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAcc}/ai/run/@cf/black-forest-labs/flux-1-schnell`, {
        method: "POST", headers: { Authorization: `Bearer ${cfTok}`, "Content-Type": "application/json" }, signal: T(40000),
        body: JSON.stringify({ prompt: p, num_steps: 8, seed }) });
      if (r.ok) { const j = await r.json(); if (j?.result?.image) return b64(j.result.image); }
      console.error("cloudflare", r.status, (await r.text()).slice(0, 200));
    } catch (e) { console.error("cloudflare", String(e)); }
  }

  // ٢) Pollinations بمفتاح (رصيد مجاني) — POLLINATIONS_KEY
  const pk = Deno.env.get("POLLINATIONS_KEY") ?? Deno.env.get("POLLINATIONS_TOKEN");
  if (pk) {
    try {
      const r = await fetch(`https://gen.pollinations.ai/image/${encodeURIComponent(p)}?model=flux&width=${w}&height=${h}&seed=${seed}&nologo=true`, { headers: { Authorization: `Bearer ${pk}` }, signal: T(40000) });
      const img = await asImage(r); if (img) return img;
      console.error("pollinations-key", r.status);
    } catch (e) { console.error("pollinations-key", String(e)); }
  }

  // ٣) Pollinations بدون مفتاح (محدود ومزدحم أحياناً) — محاولتين سريعة
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(`https://image.pollinations.ai/prompt/${encodeURIComponent(p)}?width=${w}&height=${h}&seed=${seed + i}&nologo=true&model=flux&referrer=yar-ai`, { signal: T(35000) });
      const img = await asImage(r); if (img) return img;
      console.error("pollinations", r.status);
    } catch (e) { console.error("pollinations", String(e)); }
  }
  return null;
}

const SIZES: Record<string, [number, number]> = { "1:1": [1024, 1024], "4:5": [896, 1120], "9:16": [768, 1365], "16:9": [1365, 768] };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "سجّل دخول أول" }, 401);

    const { conversation_id, message, category, ref } = await req.json();
    const hasRef = ref && typeof ref.data === "string" && ref.data.length < 8_000_000;
    const text = String(message ?? "").trim().slice(0, 2000);
    if (!text) return json({ error: "اكتب وصف الصورة" }, 400);

    const { data: planId } = await admin.rpc("effective_plan", { p_user: user.id });
    const { data: plan } = await admin.from("plans").select("*").eq("id", planId ?? "free").single();
    const limit = plan?.image_limit ?? 3;
    const { data: used } = await admin.rpc("bump_images", { p_user: user.id, p_limit: limit });
    if (used === -1) return json({ error: `وصلت حد الصور اليومي لباقة ${plan?.name ?? "المجاني"} (${limit} صور). اشترك بباقة أعلى أو ارجع باچر.`, upgrade: true }, 429);

    let spec = { prompt: text, aspect: "1:1", caption: "هاي الصورة اللي طلبتها" };
    const tp = Date.now();
    try { spec = { ...spec, ...JSON.parse(await gemText(PROMPTER, hasRef ? `The user uploaded a photo and wants it transformed: "${text}". Write the prompt for the final edited image (same subject and composition, new style).` : text)) }; } catch { /* raw text */ }
    console.log("prompt-time", Date.now() - tp, "ms");
    if (!SIZES[spec.aspect]) spec.aspect = "1:1";

    // صور Google المدفوعة بس إذا فعّلنا الدفع (GEMINI_IMAGES=1)، غير هيج نروح للمجاني مباشرة بدون انتظار
    const t0 = Date.now();
    let bytes: Uint8Array | null = null, note = "";
    if (hasRef) {
      bytes = await editImage(ref, text, spec.prompt);
      if (!bytes) note = "\n\n_ما كدرت أعدّل صورتك نفسها هسه، فسويتلك صورة جديدة بنفس الوصف._";
    }
    if (!bytes && plan?.id !== "free" && Deno.env.get("GEMINI_IMAGES") === "1") bytes = await gemImage(spec.prompt, spec.aspect);
    if (!bytes) { const [w, h] = SIZES[spec.aspect]; bytes = await freeImage(spec.prompt, w, h); }
    console.log("image-time", Date.now() - t0, "ms");
    if (!bytes) {
      await admin.rpc("bump_images", { p_user: user.id, p_limit: -999 }).then(() => {}, () => {}); // ما تنحسب محاولة فاشلة
      return json({ error: "خدمة الصور المجانية مزدحمة هسه. جرّب بعد شوية، وهاي المحاولة ما انحسبت من رصيدك." }, 503);
    }

    const path = `${user.id}/${crypto.randomUUID()}.png`;
    const up = await admin.storage.from("images").upload(path, bytes, { contentType: "image/png" });
    if (up.error) return json({ error: "ما انحفظت الصورة، جرّب مرة ثانية" }, 500);
    const imageUrl = admin.storage.from("images").getPublicUrl(path).data.publicUrl;

    let convId = conversation_id;
    if (!convId) {
      const { data: okCat } = await admin.from("categories").select("id").eq("id", category ?? "general").maybeSingle();
      const { data: c } = await admin.from("conversations").insert({ user_id: user.id, title: "🎨 " + text.slice(0, 36), category: okCat?.id ?? "general" }).select("id").single();
      convId = c!.id;
    } else {
      const { data: c } = await admin.from("conversations").select("id").eq("id", convId).eq("user_id", user.id).maybeSingle();
      if (!c) return json({ error: "المحادثة مو موجودة" }, 404);
    }
    const reply = `${spec.caption}${note}\n\n![صورة](${imageUrl})`;
    await admin.from("messages").insert([
      { conversation_id: convId, user_id: user.id, role: "user", content: (hasRef ? "🖼️ " : "🎨 ") + text },
      { conversation_id: convId, user_id: user.id, role: "assistant", content: reply },
    ]);
    await admin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", convId);
    return json({ conversation_id: convId, reply, image: imageUrl, remaining_images: limit - (used ?? 0) });
  } catch (e) {
    console.error(String(e));
    return json({ error: "صار خلل بتوليد الصورة، جرّب مرة ثانية" }, 500);
  }
});
