// يخلي يار ينصب كتطبيق. ما يخزن الصفحة حتى التحديثات توصل فوراً.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).catch(() => new Response(
      '<!doctype html><meta charset="utf-8"><body style="background:#131314;color:#e8e8ea;font-family:sans-serif;display:grid;place-items:center;height:100vh;text-align:center" dir="rtl"><div><h2>ماكو إنترنت</h2><p>يار يحتاج إنترنت حتى يشتغل. تأكد من الاتصال وارجع.</p></div>',
      { headers: { "Content-Type": "text/html; charset=utf-8" } })));
  }
});
