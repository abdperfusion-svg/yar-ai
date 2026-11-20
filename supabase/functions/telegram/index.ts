import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ===== بوت تيليگرام لـ YAR AI =====
// الإعداد: حط TELEGRAM_BOT_TOKEN بالأسرار، وبعدها افتح هذا الرابط مرة وحدة: .../functions/v1/telegram?setup=1
const MODELS = (Deno.env.get("GEMINI_MODELS") ?? "gemini-3.5-flash,gemini-3.8-flash,gemini-flash-latest,gemini-3.5-flash-lite").split(",");
const APP = "https://abdperfusion-svg.github.io/yar-ai/";
const DAILY = +(Deno.env.get("TELEGRAM_DAILY_LIMIT") ?? "20");
const PERSONA = `إنت "يار" (YAR AI)، مساعد ذكاء اصطناعي عراقي من صنع YAR Studio، وهسه تحچي ويا المستخدم بتيليگرام.
- تحچي باللهجة العراقية البيضاء، وتفهم الفصحى والكردي والتركماني والإنكليزي. إذا كتب بالكردي جاوب بالكردي.
- الدقة أهم شي: لا تخترع أرقام أو أسماء أو مصادر، وإذا ما متأكد گول.
- الأجوبة مختصرة ومرتبة تناسب الموبايل. للطبي والقانوني: معلومة عامة ونصيحة بمراجعة مختص.
- إذا طلب صور أو ملفات Word/PowerPoint أو بحث عميق بمراجع، گله هذي الميزات موجودة بتطبيق يار: ${APP}`;

async function sha(s: string) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 48); }
const tg = (token: string, method: string, body: unknown) => fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function toHtml(md: string) {
  const e = md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return e.replace(/^#{1,4}\s+(.+)$/gm, "<b>$1</b>").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>').replace(/^\s*[-*]\s+/gm, "• ");
}

async function gemini(system: string, contents: unknown[]) {
  const key = Deno.env.get("GEMINI_API_KEY")!;
  for (const [m, search] of MODELS.flatMap((m) => [[m, true], [m, false]]) as [string, boolean][]) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m.trim()}:generateContent`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, ...(search ? { tools: [{ google_search: {} }] } : {}), generationConfig: { temperature: 0.6 } }),
    }).catch(() => null);
    if (!r?.ok) continue;
    const t = (await r.json())?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
    if (t.trim()) return t;
  }
  // احتياطي مجاني
  const ork = Deno.env.get("OPENROUTER_API_KEY");
  if (ork) {
    const msgs = [{ role: "system", content: system }, ...(contents as { role: string; parts: { text: string }[] }[]).map((c) => ({ role: c.role === "model" ? "assistant" : "user", content: c.parts[0].text }))];
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ork}` }, body: JSON.stringify({ model: "openrouter/free", messages: msgs }) }).catch(() => null);
    const t = r?.ok ? (await r.json())?.choices?.[0]?.message?.content ?? "" : "";
    if (t.trim()) return t;
  }
  throw new Error("llm failed");
}

Deno.serve(async (req) => {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) return new Response("TELEGRAM_BOT_TOKEN missing", { status: 503 });
  const secret = await sha(token);
  const url = new URL(req.url);

  // ربط البوت أول مرة
  if (req.method === "GET" && url.searchParams.get("setup") === "1") {
    const hook = `${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram`;
    const r = await tg(token, "setWebhook", { url: hook, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: true });
    await tg(token, "setMyCommands", { commands: [{ command: "start", description: "ابدأ ويا يار" }, { command: "new", description: "محادثة جديدة" }, { command: "app", description: "افتح تطبيق YAR AI" }] });
    await tg(token, "setMyDescription", { description: "يار — ذكاء اصطناعي عراقي يحچي بلهجتك ويساعدك بكل شغلك. من YAR Studio." });
    return new Response(JSON.stringify(await r.json()), { headers: { "Content-Type": "application/json" } });
  }
  if (req.headers.get("x-telegram-bot-api-secret-token") !== secret) return new Response("forbidden", { status: 403 });

  const upd = await req.json().catch(() => ({}));
  const msg = upd?.message;
  const chatId: number | undefined = msg?.chat?.id;
  const text: string = (msg?.text ?? msg?.caption ?? "").trim();
  if (!chatId) return new Response("ok");

  // نرد بالخلفية حتى تيليگرام ما يعيد الإرسال
  EdgeRuntime.waitUntil((async () => {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const send = async (t: string) => {
      const html = toHtml(t);
      for (let i = 0; i < html.length; i += 3900) {
        const part = html.slice(i, i + 3900);
        const r = await tg(token, "sendMessage", { chat_id: chatId, text: part, parse_mode: "HTML", disable_web_page_preview: true });
        if (!r.ok) await tg(token, "sendMessage", { chat_id: chatId, text: t.slice(i, i + 3900) });
      }
    };
    try {
      const name = msg?.from?.first_name ? ` ${msg.from.first_name}` : "";
      if (!text) return await send("حالياً أفهم الرسائل المكتوبة بس 🙏 للصور والملفات استخدم تطبيق يار:\n" + APP);
      if (text.startsWith("/start")) return await send(`هلا بيك${name} 👋\nأني **يار**، ذكاء اصطناعي عراقي من YAR Studio.\nاسألني أي شي: دراسة، شغل، كتابة، ترجمة، أفكار…\n\nللبحوث بمراجع حقيقية، الصور، وملفات Word و PowerPoint، استخدم التطبيق:\n${APP}`);
      if (text.startsWith("/new")) { await admin.from("tg_messages").delete().eq("chat_id", chatId); return await send("تمام، بدينا محادثة جديدة ✨"); }
      if (text.startsWith("/app")) return await send(`افتح YAR AI من هنا:\n${APP}`);

      const since = new Date(); since.setUTCHours(0, 0, 0, 0);
      const { count } = await admin.from("tg_messages").select("id", { count: "exact", head: true }).eq("chat_id", chatId).eq("role", "user").gte("created_at", since.toISOString());
      if ((count ?? 0) >= DAILY) return await send(`وصلت الحد اليومي بتيليگرام (${DAILY} رسالة) 🙏\nكمّل بتطبيق يار، وبيه باقات أكثر:\n${APP}`);

      await tg(token, "sendChatAction", { chat_id: chatId, action: "typing" });
      const { data: hist } = await admin.from("tg_messages").select("role,content").eq("chat_id", chatId).order("created_at", { ascending: false }).limit(16);
      const contents = [...(hist ?? []).reverse().map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })), { role: "user", parts: [{ text: text.slice(0, 6000) }] }];
      const reply = await gemini(PERSONA + `\nاسم المستخدم: ${msg?.from?.first_name ?? "غير معروف"}. تاريخ اليوم: ${new Date().toISOString().slice(0, 10)}.`, contents);
      await admin.from("tg_messages").insert([{ chat_id: chatId, role: "user", content: text.slice(0, 6000) }, { chat_id: chatId, role: "assistant", content: reply.slice(0, 12000) }]);
      await send(reply);
    } catch (e) {
      console.error(String(e));
      await send("صار خلل مؤقت، جرّب بعد شوية 🙏");
    }
  })());
  return new Response("ok");
});
