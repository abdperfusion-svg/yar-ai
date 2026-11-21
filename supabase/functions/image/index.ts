import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const TEXT_MODELS = ["gemini-3.5-flash-lite", ...(Deno.env.get("GEMINI_MODELS") ?? "gemini-3.5-flash,gemini-flash-latest").split(",")];
const IMG_MODELS = (Deno.env.get("GEMINI_IMAGE_MODELS") ?? "gemini-nano-banana-2.1,gemini-3.1-flash-image,gemini-2.5-flash-image").split(",");
const PRO_LOGO_COST = 5, PRO_POSTER_COST = 2; // نقاط التصميم الاحترافي للمستخدم المجاني
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const T = (ms: number) => AbortSignal.timeout(ms);

const PROMPTER = `You turn a user's image request (often Iraqi Arabic or Kurdish) into one excellent English prompt for an AI image model.
Rules: describe subject, setting, composition, lighting, style, camera/lens if photographic, colours, mood. Photorealistic unless the user asks for another style.
People: Iraqi or Kurdish looking, local styling. Iraqi men wear Iraqi dress (shemagh wrapped as jarawiya, striped zboun with sitra jacket, or modern clothes) never Gulf agal or white Gulf dishdasha. Kurdish context means Kurdish clothing.
TEXT RULE (very important): image models cannot write Arabic or Kurdish correctly, so the image must contain NO text at all: no letters, words, numbers, signs, labels or watermarks. If the user wants any words (a logo name, a title, a slogan, a price, a phone), copy those exact words (in the user's language and spelling) into "text", and design the picture with clean empty space for them: for a logo use a simple centered emblem/icon on a plain background with nothing written; for posters keep a calm empty area at the top or bottom. Always end the prompt with: "no text, no letters, no typography, no watermark".
"pos" says where the words go: "logo" (written under the emblem), "bottom" or "top". If the user wants no words, "text" is "".
DESIGN MODE: if the user asks for an ad, post, story, poster, flyer or social-media design (اعلان، بوست، ستوري، بوستر، تصميم), also fill "design": {"brand": business name, "title": a short catchy headline (2-5 words) in the user's language, "subtitle": one short supporting line, "cta": a short call to action like "اسألي واطلبي من صيدلية ريحانة", "phone": phone if given, "site": website if given, "color": a deep brand hex colour (e.g. "#0f5d3a" green, "#1d3b8f" blue) matching the request}. Use only names, phones and sites the user gave; never invent them (leave "" instead). For design mode: aspect "9:16" for a story, "4:5" for a post; the picture is a realistic photo of the subject in the middle of the frame, with the top 30% and bottom 15% of the frame calm, soft and empty (plain or softly blurred background) so text can sit there, and the subject's face never at the very top. Leave "text" empty in design mode.
IDENTITY MODE: if the user asks for a logo, visual identity or branding (شعار، لوكو، هوية بصرية، براند، علامة تجارية), fill "identity": {"brand": the business name exactly as the user wrote it, "tagline": a short slogan in the user's language, "colors": three brand hex colours (main, accent, dark) that fit the business}. The prompt is then ONLY the logo symbol: a clean modern flat vector emblem/icon that represents the business (for example a cheese wedge with a drop of milk for a cheese factory), using the brand colours, centered on a pure white background, generous empty margin, simple shapes, professional brand mark, no text. aspect "1:1". Leave "text" empty and "design" null in identity mode.
No nudity, no real public figures, no brand logos.
Return JSON only: {"prompt":"...","aspect":"1:1|4:5|9:16|16:9","caption":"one short Iraqi-Arabic sentence describing exactly what was drawn","text":"","pos":"bottom","design":null,"identity":null}`;

async function gemText(system: string, text: string) {
  // ١) Cloudflare (رصيد مجاني منفصل عن Google وسريع)
  const cfAcc = Deno.env.get("CF_ACCOUNT_ID"), cfTok = Deno.env.get("CF_API_TOKEN");
  if (cfAcc && cfTok) {
    const t = Date.now();
    try {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAcc}/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast`, {
        method: "POST", headers: { Authorization: `Bearer ${cfTok}`, "Content-Type": "application/json" }, signal: T(15000),
        body: JSON.stringify({ messages: [{ role: "system", content: system }, { role: "user", content: text }], max_tokens: 700, temperature: 0.7 }) });
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

// شعار احترافي فيكتر (SVG) من Recraft
async function recraftLogo(prompt: string): Promise<{ bytes: Uint8Array; svg: boolean } | null> {
  const key = Deno.env.get("RECRAFT_API_KEY");
  if (!key) return null;
  for (const style of ["vector_illustration", "digital_illustration"]) {
    const r = await fetch("https://external.api.recraft.ai/v1/images/generations", { method: "POST", signal: T(90000),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: prompt.slice(0, 1000), style, model: Deno.env.get("RECRAFT_MODEL") ?? "recraftv3", size: "1024x1024", n: 1, response_format: "url" }) }).catch(() => null);
    if (!r?.ok) { console.error("recraft", style, r?.status, r ? (await r.text()).slice(0, 200) : ""); continue; }
    const u = (await r.json())?.data?.[0]?.url;
    if (!u) continue;
    const f = await fetch(u, { signal: T(30000) }).catch(() => null);
    if (!f?.ok) continue;
    const ct = f.headers.get("content-type") ?? "";
    return { bytes: new Uint8Array(await f.arrayBuffer()), svg: ct.includes("svg") || /\.svg(\?|$)/i.test(u) };
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
  // ١) Flux 2: دقة أعلى وتفاصيل أحسن، وبالمقاس المطلوب
  if (cfAcc && cfTok) {
    for (const model of ["@cf/black-forest-labs/flux-2-klein-9b", "@cf/black-forest-labs/flux-2-klein-4b"]) {
      const t = Date.now();
      try {
        const form = new FormData();
        form.append("prompt", p); form.append("width", String(w)); form.append("height", String(h)); form.append("seed", String(seed));
        const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAcc}/ai/run/${model}`, { method: "POST", headers: { Authorization: `Bearer ${cfTok}` }, signal: T(45000), body: form });
        console.log("gen", model, r.status, Date.now() - t);
        if (r.ok) {
          const ct = r.headers.get("content-type") ?? "";
          if (ct.startsWith("image/")) return new Uint8Array(await r.arrayBuffer());
          const j = await r.json(); if (j?.result?.image) return b64(j.result.image);
        } else console.error("gen", model, (await r.text()).slice(0, 200));
      } catch (e) { console.error("gen", model, String(e)); }
    }
  }
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

const SIZES: Record<string, [number, number]> = { "1:1": [1440, 1440], "4:5": [1152, 1440], "9:16": [1080, 1920], "16:9": [1920, 1080] };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "سجّل دخول أول" }, 401);

    const body = await req.json();
    // الكتابة العربية تنضاف بالتطبيق فوگ الصورة، وهنا نحفظ النسخة النهائية مكان القديمة
    if (body.action === "overlay") {
      const { conversation_id: cid, old_url, png } = body;
      if (!cid || !old_url || typeof png !== "string" || png.length > 12_000_000) return json({ error: "bad" }, 400);
      const { data: conv } = await admin.from("conversations").select("id").eq("id", cid).eq("user_id", user.id).maybeSingle();
      if (!conv) return json({ error: "المحادثة مو موجودة" }, 404);
      const path2 = `${user.id}/${crypto.randomUUID()}.png`;
      const up2 = await admin.storage.from("images").upload(path2, b64(png), { contentType: "image/png" });
      if (up2.error) return json({ error: "ما انحفظت" }, 500);
      const url2 = admin.storage.from("images").getPublicUrl(path2).data.publicUrl;
      const { data: msgs } = await admin.from("messages").select("id,content").eq("conversation_id", cid).eq("user_id", user.id).eq("role", "assistant").like("content", `%${old_url}%`);
      for (const m of msgs ?? []) await admin.from("messages").update({ content: m.content.replace(old_url, url2) }).eq("id", m.id);
      return json({ image: url2 });
    }
    const { conversation_id, message, category, ref } = body;
    const hasRef = ref && typeof ref.data === "string" && ref.data.length < 8_000_000;
    const text = String(message ?? "").trim().slice(0, 2000);
    if (!text) return json({ error: "اكتب وصف الصورة" }, 400);

    const { data: planId } = await admin.rpc("effective_plan", { p_user: user.id });
    const { data: plan } = await admin.from("plans").select("*").eq("id", planId ?? "free").single();
    const limit = plan?.image_limit ?? 3;
    const { data: used } = await admin.rpc("bump_images", { p_user: user.id, p_limit: limit });
    // خلصت صور اليوم المجانية؟ ناخذ نقطة وحدة من رصيد النقاط
    let pointPaid = false, pointsLeft: number | null = null;
    if (used === -1) {
      const { data: left } = await admin.rpc("spend_points", { p_user: user.id, p_cost: 1, p_reason: hasRef ? "تعديل صورة" : "صورة" });
      if (left === -1 || left === null) return json({ error: `خلصت صورك المجانية لليوم (${limit} صور) ونقاطك ما تكفي. اشحن نقاط من «الباقات والنقاط» أو ارجع باچر.`, upgrade: true }, 429);
      pointPaid = true; pointsLeft = left;
    }

    let spec: { prompt: string; aspect: string; caption: string; text: string; pos: string; design?: Record<string, string> | null; identity?: { brand?: string; tagline?: string; colors?: string[] } | null } = { prompt: text, aspect: "1:1", caption: "هاي الصورة اللي طلبتها", text: "", pos: "bottom", design: null };
    const tp = Date.now();
    try { spec = { ...spec, ...JSON.parse(await gemText(PROMPTER, hasRef ? `The user uploaded a photo and wants it transformed: "${text}". Write the prompt for the final edited image (same subject and composition, new style).` : text)) }; } catch { /* raw text */ }
    console.log("prompt-time", Date.now() - tp, "ms");
    if (!SIZES[spec.aspect]) spec.aspect = "1:1";
    const overlayText = hasRef ? "" : String(spec.text ?? "").trim().slice(0, 80);
    const d = !hasRef && spec.design && typeof spec.design === "object" && spec.design.title ? spec.design : null;
    const design = d ? Object.fromEntries(["brand", "title", "subtitle", "cta", "phone", "site", "color"].map((k) => [k, String(d[k] ?? "").trim().slice(0, 90)])) : null;
    const idn = !hasRef && spec.identity && typeof spec.identity === "object" && spec.identity.brand ? spec.identity : null;
    const identity = idn ? { brand: String(idn.brand).slice(0, 60), tagline: String(idn.tagline ?? "").slice(0, 90), colors: (Array.isArray(idn.colors) ? idn.colors : []).filter((c) => /^#[0-9a-f]{6}$/i.test(String(c))).slice(0, 3) } : null;
    if (identity) spec.aspect = "1:1";
    if ((overlayText || design || identity) && !/no text/i.test(spec.prompt)) spec.prompt += ". no text, no letters, no typography, no watermark";

    // صور Google المدفوعة بس إذا فعّلنا الدفع (GEMINI_IMAGES=1)، غير هيج نروح للمجاني مباشرة بدون انتظار
    const t0 = Date.now();
    let bytes: Uint8Array | null = null, note = "";
    if (hasRef) {
      bytes = await editImage(ref, text, spec.prompt);
      if (!bytes) note = "\n\n_ما كدرت أعدّل صورتك نفسها هسه، فسويتلك صورة جديدة بنفس الوصف._";
    }
    // التصميم الاحترافي: الشعار من Recraft، والبوستر من Nano Banana. مجاني للمشتركين، والباقين بالنقاط
    let isSvg = false, proPaid = 0, proNote = "";
    const wantPro = !hasRef && ((identity && !!Deno.env.get("RECRAFT_API_KEY")) || (design && Deno.env.get("GEMINI_IMAGES") === "1"));
    if (wantPro) {
      const cost = identity ? PRO_LOGO_COST : PRO_POSTER_COST;
      const { data: isAdm } = await admin.rpc("is_admin_user", { p_user: user.id }).then((x) => x, () => ({ data: false }));
      let allowed = plan?.id !== "free" || !!isAdm;
      if (!allowed) {
        const { data: left } = await admin.rpc("spend_points", { p_user: user.id, p_cost: cost, p_reason: identity ? "شعار احترافي" : "تصميم احترافي" });
        if (typeof left === "number" && left >= 0) { allowed = true; proPaid = cost; pointsLeft = left; }
        else proNote = `\n\n_التصميم الاحترافي يحتاج ${cost} نقاط ونقاطك ما تكفي، فسويتلك نسخة بالرسام المجاني. تكدر تشحن نقاط من «الباقات والنقاط»._`;
      }
      if (allowed) {
        if (identity) { const rc = await recraftLogo(spec.prompt); if (rc) { bytes = rc.bytes; isSvg = rc.svg; } }
        else bytes = await gemImage(spec.prompt, spec.aspect);
        if (!bytes && proPaid) { await admin.rpc("refund_points", { p_user: user.id, p_amount: proPaid, p_reason: "إرجاع: التصميم الاحترافي ما اشتغل" }).then(() => {}, () => {}); proPaid = 0; proNote = "\n\n_الرسام الاحترافي ما اشتغل هالمرة فرجعتلك نقاطك، وهاي نسخة بالرسام المجاني._"; }
      }
    }
    note += proNote;
    if (!bytes && !wantPro && plan?.id !== "free" && Deno.env.get("GEMINI_IMAGES") === "1") bytes = await gemImage(spec.prompt, spec.aspect);
    if (!bytes) { const [w, h] = SIZES[spec.aspect]; bytes = await freeImage(spec.prompt, w, h); }
    console.log("image-time", Date.now() - t0, "ms");
    if (!bytes) {
      if (pointPaid) await admin.rpc("refund_points", { p_user: user.id, p_amount: 1, p_reason: "إرجاع: صورة ما طلعت" }).then(() => {}, () => {});
      else await admin.rpc("bump_images", { p_user: user.id, p_limit: -999 }).then(() => {}, () => {}); // ما تنحسب محاولة فاشلة
      return json({ error: "خدمة الصور المجانية مزدحمة هسه. جرّب بعد شوية، وهاي المحاولة ما انحسبت من رصيدك." }, 503);
    }

    const path = `${user.id}/${crypto.randomUUID()}.${isSvg ? "svg" : "png"}`;
    const up = await admin.storage.from("images").upload(path, bytes, { contentType: isSvg ? "image/svg+xml" : "image/png" });
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
    const reply = `${spec.caption}${note}\n\n![صورة](${imageUrl})` + (isSvg ? `\n\n⬇️ [نزّل الشعار كملف فيكتر SVG (يتعدّل بالفوتوشوب والإلستريتر)](${imageUrl})` : "");
    await admin.from("messages").insert([
      { conversation_id: convId, user_id: user.id, role: "user", content: (hasRef ? "🖼️ " : "🎨 ") + text },
      { conversation_id: convId, user_id: user.id, role: "assistant", content: reply },
    ]);
    await admin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", convId);
    return json({ conversation_id: convId, reply, image: imageUrl, remaining_images: pointPaid ? 0 : limit - (used ?? 0), points: pointsLeft, overlay: identity ? { kind: "identity", ...identity } : design ? { kind: "poster", ...design } : overlayText ? { text: overlayText, pos: ["logo", "top", "bottom"].includes(spec.pos) ? spec.pos : "bottom" } : null });
  } catch (e) {
    console.error(String(e));
    return json({ error: "صار خلل بتوليد الصورة، جرّب مرة ثانية" }, 500);
  }
});
