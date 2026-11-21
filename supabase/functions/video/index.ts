import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// فيديو احترافي بالذكاء الاصطناعي عن طريق Higgsfield.
// مطفّي لحد ما ينحط HF_KEY_ID و HF_KEY_SECRET بالأسرار. الكلفة تنسحب من نقاط المستخدم، وترجع إذا فشل.
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const T = (ms: number) => AbortSignal.timeout(ms);
const BASE = Deno.env.get("HF_BASE") ?? "https://api.higgsfield.ai";
const MODEL = Deno.env.get("HF_VIDEO_MODEL") ?? "kling-video/v2.5/turbo/image-to-video";
const COST = Number(Deno.env.get("HF_VIDEO_COST") ?? "40");
const auth = () => `Key ${Deno.env.get("HF_KEY_ID")}:${Deno.env.get("HF_KEY_SECRET")}`;
const enabled = () => !!(Deno.env.get("HF_KEY_ID") && Deno.env.get("HF_KEY_SECRET"));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "سجّل دخول أول" }, 401);
    const body = await req.json().catch(() => ({}));

    if (body.action === "info") return json({ enabled: enabled(), cost: COST });
    if (!enabled()) return json({ error: "الفيديو الاحترافي بعده ما تفعّل" }, 503);

    // ١) نبدي فيديو جديد من صورة
    if (body.action === "start") {
      const img = String(body.image_url ?? "");
      if (!/^https:\/\/wnjhsgjctevpaftvlcyr\.supabase\.co\/storage\//.test(img)) return json({ error: "الصورة لازم تكون من صور يار" }, 400);
      const prompt = String(body.prompt ?? "").slice(0, 800) || "smooth cinematic camera movement, subtle natural motion, professional commercial look";
      const { data: isAdm } = await admin.rpc("is_admin_user", { p_user: user.id }).then((x) => x, () => ({ data: false }));
      let cost = 0, left: number | null = null;
      if (!isAdm) {
        const { data: l } = await admin.rpc("spend_points", { p_user: user.id, p_cost: COST, p_reason: "فيديو احترافي" });
        if (typeof l !== "number" || l < 0) return json({ error: `الفيديو الاحترافي يحتاج ${COST} نقطة ونقاطك ما تكفي. اشحن من «الباقات والنقاط».`, upgrade: true }, 402);
        cost = COST; left = l;
      }
      const r = await fetch(`${BASE}/${MODEL}`, { method: "POST", signal: T(30000),
        headers: { Authorization: auth(), "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, image_url: img, input_image: img, duration: 5 }) }).catch(() => null);
      const j = r?.ok ? await r.json().catch(() => null) : null;
      if (!j?.request_id) {
        console.error("hf start", r?.status, r ? (await r.text().catch(() => "")).slice(0, 300) : "");
        if (cost) await admin.rpc("refund_points", { p_user: user.id, p_amount: cost, p_reason: "إرجاع: الفيديو ما بدا" }).then(() => {}, () => {});
        return json({ error: "خدمة الفيديو ما ردّت هسه، ورجعتلك نقاطك. جرّب بعد شوية." }, 502);
      }
      const { data: job } = await admin.from("video_jobs").insert({ user_id: user.id, conversation_id: body.conversation_id ?? null, request_id: j.request_id, cost }).select("id").single();
      return json({ job_id: job!.id, points: left });
    }

    // ٢) نشيّك على الفيديو لحد ما يخلص
    if (body.action === "status") {
      const { data: job } = await admin.from("video_jobs").select("*").eq("id", body.job_id).eq("user_id", user.id).maybeSingle();
      if (!job) return json({ error: "ما لگيت الطلب" }, 404);
      if (job.status === "completed" || job.status === "failed") return json({ status: job.status, video: job.video_url, error: job.error });
      const r = await fetch(`${BASE}/requests/${job.request_id}/status`, { headers: { Authorization: auth() }, signal: T(20000) }).catch(() => null);
      const s = r?.ok ? await r.json().catch(() => null) : null;
      const st = String(s?.status ?? "queued").toLowerCase();
      if (st === "completed" && s?.video?.url) {
        let final = s.video.url;
        try { // ننسخه لتخزيننا لأن روابطهم تنتهي بعد ٧ أيام
          const f = await fetch(final, { signal: T(60000) });
          if (f.ok) {
            const path = `${user.id}/${crypto.randomUUID()}.mp4`;
            const up = await admin.storage.from("images").upload(path, new Uint8Array(await f.arrayBuffer()), { contentType: "video/mp4" });
            if (!up.error) final = admin.storage.from("images").getPublicUrl(path).data.publicUrl;
          }
        } catch { /* نخلي رابطهم */ }
        await admin.from("video_jobs").update({ status: "completed", video_url: final, updated_at: new Date().toISOString() }).eq("id", job.id);
        if (job.conversation_id) await admin.from("messages").insert({ conversation_id: job.conversation_id, user_id: user.id, role: "assistant", content: `🎬 الفيديو الاحترافي جاهز:\n\n[▶️ شغّل ونزّل الفيديو](${final})` });
        return json({ status: "completed", video: final });
      }
      if (["failed", "nsfw", "canceled", "cancelled"].includes(st)) {
        if (job.cost) await admin.rpc("refund_points", { p_user: user.id, p_amount: job.cost, p_reason: "إرجاع: الفيديو فشل" }).then(() => {}, () => {});
        const msg = st === "nsfw" ? "الصورة ما تنفع للفيديو، جرّب صورة ثانية" : "الفيديو ما زبط";
        await admin.from("video_jobs").update({ status: "failed", error: msg, updated_at: new Date().toISOString() }).eq("id", job.id);
        return json({ status: "failed", error: msg + "، ورجعتلك نقاطك." });
      }
      return json({ status: st === "in_progress" ? "in_progress" : "queued" });
    }
    return json({ error: "bad" }, 400);
  } catch (e) {
    console.error(String(e));
    return json({ error: "صار خلل، جرّب مرة ثانية" }, 500);
  }
});
