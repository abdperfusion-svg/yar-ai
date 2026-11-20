// كاش يار: يفتح البرنامج بسرعة حتى على نت ضعيف، والتحديثات توصل من شريط التحديث
const V = "yar-v2";
const STATIC = /^https:\/\/esm\.sh\/|\.(png|svg|json|woff2?)$/;

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(V).then((c) => c.addAll(["./", "index.html", "logo.svg", "icon-192.png", "manifest.json"]).catch(() => {})));
});
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== V) await caches.delete(k);
  await self.clients.claim();
})()));

const OFFLINE = () => new Response(
  '<!doctype html><meta charset="utf-8"><body style="background:#131314;color:#e8e8ea;font-family:sans-serif;display:grid;place-items:center;height:100vh;text-align:center" dir="rtl"><div><h2>ماكو إنترنت</h2><p>يار يحتاج إنترنت حتى يشتغل. تأكد من الاتصال وارجع.</p></div>',
  { headers: { "Content-Type": "text/html; charset=utf-8" } });

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith("supabase.co") || url.pathname.endsWith("version.json")) return; // البيانات دائماً من السيرفر

  // الصفحة: من النت أول (٣ ثواني)، وإذا النت بطيء نفتح النسخة المحفوظة فوراً
  if (req.mode === "navigate") {
    e.respondWith((async () => {
      const cache = await caches.open(V);
      const net = fetch(req).then((r) => { if (r.ok) cache.put("index.html", r.clone()); return r; });
      const timeout = new Promise((res) => setTimeout(res, 3000));
      const r = await Promise.race([net.catch(() => null), timeout]);
      if (r) return r;
      return (await cache.match("index.html")) || net.catch(OFFLINE);
    })());
    return;
  }

  // المكتبات والأيقونات: من الكاش مباشرة (ما تتغير)
  if (STATIC.test(req.url)) {
    e.respondWith((async () => {
      const cache = await caches.open(V);
      const hit = await cache.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok || r.type === "opaque") cache.put(req, r.clone());
      return r;
    })());
  }
});
