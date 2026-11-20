import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ===== بحث عميق: يجمع من مصادر علمية عالمية + الويب، ويكتب تقرير بمراجع حقيقية =====
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MODELS = (Deno.env.get("GEMINI_MODELS") ?? "gemini-3.5-flash,gemini-3.8-flash,gemini-flash-latest,gemini-3.5-flash-lite").split(",");
const UA = { "User-Agent": "YAR-AI/1.0 (https://abdperfusion-svg.github.io/yar-ai/)" };
const T = (ms: number) => AbortSignal.timeout(ms);

type Src = { kind: string; title: string; authors: string[]; year?: number; venue?: string; doi?: string; url?: string; pdf?: string; abstract?: string; cites?: number; body?: string };

async function gemini(system: string, user: string, opts: { json?: boolean; search?: boolean } = {}) {
  const key = Deno.env.get("GEMINI_API_KEY")!;
  for (const m of MODELS) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m.trim()}:generateContent`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: user }] }],
        ...(opts.search ? { tools: [{ google_search: {} }] } : {}),
        generationConfig: { temperature: opts.json ? 0.1 : 0.4, ...(opts.json ? { responseMimeType: "application/json" } : {}) } }),
    }).catch(() => null);
    if (!r?.ok) continue;
    const j = await r.json();
    const c = j?.candidates?.[0];
    const text = c?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
    if (!text.trim()) continue;
    const web = (c?.groundingMetadata?.groundingChunks ?? []).map((x: { web?: { uri: string; title: string } }) => x.web).filter(Boolean);
    return { text, web: web as { uri: string; title: string }[] };
  }
  throw new Error("gemini failed");
}

async function geminiStream(system: string, user: string, onText: (t: string) => void) {
  const key = Deno.env.get("GEMINI_API_KEY")!;
  for (const m of MODELS) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m.trim()}:streamGenerateContent?alt=sse`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: user }] }], generationConfig: { temperature: 0.4 } }),
    }).catch(() => null);
    if (!r?.ok || !r.body) continue;
    const rd = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "", full = "";
    while (true) {
      const { value, done } = await rd.read(); if (done) break;
      buf += value; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        try { const t = JSON.parse(line.slice(5))?.candidates?.[0]?.content?.parts?.map((p: { text?: string; thought?: boolean }) => p.thought ? "" : (p.text ?? "")).join("") ?? ""; if (t) { full += t; onText(t); } } catch { /* */ }
      }
    }
    if (full.trim()) return full;
  }
  throw new Error("gemini stream failed");
}

const clean = (s?: string) => (s ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const getJ = async (url: string, ms = 12000, headers: Record<string, string> = {}) => { try { const r = await fetch(url, { headers: { ...UA, ...headers }, signal: T(ms) }); return r.ok ? await r.json() : null; } catch { return null; } };
const getT = async (url: string, ms = 12000) => { try { const r = await fetch(url, { headers: UA, signal: T(ms) }); return r.ok ? await r.text() : ""; } catch { return ""; } };

// ---- المصادر ----
async function openAlex(q: string): Promise<Src[]> {
  const mail = Deno.env.get("CONTACT_EMAIL");
  const j = await getJ(`https://api.openalex.org/works?search=${encodeURIComponent(q)}&per-page=8&filter=has_abstract:true${mail ? "&mailto=" + encodeURIComponent(mail) : ""}`);
  return (j?.results ?? []).map((w: any) => {
    let abs = "";
    if (w.abstract_inverted_index) { const pos: [number, string][] = []; for (const [k, v] of Object.entries(w.abstract_inverted_index)) for (const p of v as number[]) pos.push([p, k]); abs = pos.sort((a, b) => a[0] - b[0]).map((x) => x[1]).join(" "); }
    return { kind: "OpenAlex", title: clean(w.title), authors: (w.authorships ?? []).slice(0, 6).map((a: any) => a.author?.display_name).filter(Boolean), year: w.publication_year,
      venue: w.primary_location?.source?.display_name, doi: w.doi?.replace("https://doi.org/", ""), url: w.doi ?? w.id, pdf: w.open_access?.oa_url, abstract: abs.slice(0, 1800), cites: w.cited_by_count };
  });
}
async function semanticScholar(q: string): Promise<Src[]> {
  const k = Deno.env.get("S2_API_KEY");
  const j = await getJ(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=8&fields=title,year,authors,venue,abstract,externalIds,openAccessPdf,citationCount,url,tldr`, 12000, k ? { "x-api-key": k } : {});
  return (j?.data ?? []).map((p: any) => ({ kind: "Semantic Scholar", title: clean(p.title), authors: (p.authors ?? []).slice(0, 6).map((a: any) => a.name), year: p.year, venue: p.venue,
    doi: p.externalIds?.DOI, url: p.externalIds?.DOI ? `https://doi.org/${p.externalIds.DOI}` : p.url, pdf: p.openAccessPdf?.url, abstract: clean(p.abstract || p.tldr?.text).slice(0, 1800), cites: p.citationCount }));
}
async function crossref(q: string): Promise<Src[]> {
  const mail = Deno.env.get("CONTACT_EMAIL");
  const j = await getJ(`https://api.crossref.org/works?query=${encodeURIComponent(q)}&rows=5&select=DOI,title,author,issued,container-title,abstract,is-referenced-by-count${mail ? "&mailto=" + encodeURIComponent(mail) : ""}`);
  return (j?.message?.items ?? []).map((w: any) => ({ kind: "CrossRef", title: clean(w.title?.[0]), authors: (w.author ?? []).slice(0, 6).map((a: any) => [a.given, a.family].filter(Boolean).join(" ")),
    year: w.issued?.["date-parts"]?.[0]?.[0], venue: w["container-title"]?.[0], doi: w.DOI, url: `https://doi.org/${w.DOI}`, abstract: clean(w.abstract).slice(0, 1800), cites: w["is-referenced-by-count"] }));
}
async function pubmed(q: string): Promise<Src[]> {
  const s = await getJ(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=6&sort=relevance&term=${encodeURIComponent(q)}`);
  const ids: string[] = s?.esearchresult?.idlist ?? [];
  if (!ids.length) return [];
  const x = await getT(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&retmode=xml&id=${ids.join(",")}`, 15000);
  return x.split("<PubmedArticle>").slice(1).map((a) => {
    const g = (re: RegExp) => clean(a.match(re)?.[1]);
    const authors = [...a.matchAll(/<LastName>(.*?)<\/LastName>\s*<ForeName>(.*?)<\/ForeName>/g)].slice(0, 6).map((m) => `${m[2]} ${m[1]}`);
    const pmid = g(/<PMID[^>]*>(\d+)<\/PMID>/);
    const doi = g(/<ArticleId IdType="doi">(.*?)<\/ArticleId>/);
    return { kind: "PubMed", title: g(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/), authors, year: +g(/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/) || undefined,
      venue: g(/<Title>([\s\S]*?)<\/Title>/), doi: doi || undefined, url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      abstract: [...a.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g)].map((m) => clean(m[1])).join(" ").slice(0, 1800) };
  });
}
async function arxiv(q: string): Promise<Src[]> {
  const x = await getT(`https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&max_results=5&sortBy=relevance`);
  return x.split("<entry>").slice(1).map((e) => {
    const g = (re: RegExp) => clean(e.match(re)?.[1]);
    const id = g(/<id>(.*?)<\/id>/);
    return { kind: "arXiv", title: g(/<title>([\s\S]*?)<\/title>/), authors: [...e.matchAll(/<name>(.*?)<\/name>/g)].slice(0, 6).map((m) => m[1]),
      year: +g(/<published>(\d{4})/) || undefined, venue: "arXiv", url: id, pdf: id.replace("/abs/", "/pdf/"), abstract: g(/<summary>([\s\S]*?)<\/summary>/).slice(0, 1800) };
  });
}
async function wikipedia(q: string, lang: string): Promise<Src[]> {
  const j = await getJ(`https://${lang}.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrlimit=2&prop=extracts|info&inprop=url&exintro=1&explaintext=1`);
  return Object.values(j?.query?.pages ?? {}).map((p: any) => ({ kind: "Wikipedia", title: p.title, authors: ["Wikipedia contributors"], year: new Date().getFullYear(), venue: `Wikipedia (${lang})`, url: p.fullurl, abstract: clean(p.extract).slice(0, 1500) }));
}
async function openFDA(drug: string): Promise<Src[]> {
  const j = await getJ(`https://api.fda.gov/drug/label.json?limit=1&search=openfda.generic_name:"${encodeURIComponent(drug)}"+openfda.brand_name:"${encodeURIComponent(drug)}"`);
  const r = j?.results?.[0]; if (!r) return [];
  const pick = (k: string) => clean(Array.isArray(r[k]) ? r[k][0] : "").slice(0, 600);
  return [{ kind: "openFDA", title: `${r.openfda?.brand_name?.[0] ?? drug} (${r.openfda?.generic_name?.[0] ?? drug}) — Drug label`, authors: ["U.S. Food and Drug Administration"], year: +String(r.effective_time ?? "").slice(0, 4) || undefined,
    venue: "openFDA", url: `https://open.fda.gov/`, abstract: ["indications_and_usage", "dosage_and_administration", "warnings", "drug_interactions", "adverse_reactions"].map((k) => pick(k) && `${k}: ${pick(k)}`).filter(Boolean).join(" | ") }];
}
async function unpaywall(doi: string) {
  const mail = Deno.env.get("CONTACT_EMAIL"); if (!mail) return undefined;
  const j = await getJ(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(mail)}`, 8000);
  return j?.best_oa_location?.url_for_pdf ?? j?.best_oa_location?.url ?? undefined;
}
async function jinaRead(url: string) {
  const k = Deno.env.get("JINA_API_KEY");
  try { const r = await fetch(`https://r.jina.ai/${url}`, { headers: { ...UA, Accept: "text/plain", ...(k ? { Authorization: `Bearer ${k}` } : {}) }, signal: T(20000) }); return r.ok ? clean(await r.text()).slice(0, 6000) : ""; } catch { return ""; }
}
async function tavily(q: string): Promise<Src[]> {
  const k = Deno.env.get("TAVILY_API_KEY"); if (!k) return [];
  try {
    const r = await fetch("https://api.tavily.com/search", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${k}` }, signal: T(15000),
      body: JSON.stringify({ query: q, max_results: 5, search_depth: "advanced" }) });
    const j = r.ok ? await r.json() : null;
    return (j?.results ?? []).map((x: any) => ({ kind: "Web", title: clean(x.title), authors: [new URL(x.url).hostname], year: new Date().getFullYear(), url: x.url, abstract: clean(x.content).slice(0, 1500) }));
  } catch { return []; }
}
async function exa(q: string): Promise<Src[]> {
  const k = Deno.env.get("EXA_API_KEY"); if (!k) return [];
  try {
    const r = await fetch("https://api.exa.ai/search", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": k }, signal: T(15000),
      body: JSON.stringify({ query: q, numResults: 5, contents: { text: { maxCharacters: 1500 } } }) });
    const j = r.ok ? await r.json() : null;
    return (j?.results ?? []).map((x: any) => ({ kind: "Web", title: clean(x.title), authors: [x.author || new URL(x.url).hostname], year: +String(x.publishedDate ?? "").slice(0, 4) || undefined, url: x.url, abstract: clean(x.text).slice(0, 1500) }));
  } catch { return []; }
}

function apa(s: Src, n: number) {
  const au = s.authors.length ? (s.authors.length > 3 ? `${s.authors.slice(0, 3).join(", ")}, et al.` : s.authors.join(", ")) : "";
  const link = s.doi ? `https://doi.org/${s.doi}` : s.url;
  return `${n}. ${au}${au ? " " : ""}(${s.year ?? "n.d."}). ${s.title}.${s.venue ? ` *${s.venue}*.` : ""} ${link ? `[${link}](${link})` : ""}${s.pdf && s.pdf !== link ? ` · [PDF](${s.pdf})` : ""}`;
}

const PLANNER = `إنت مخطط بحث أكاديمي. من طلب المستخدم طلّع JSON فقط:
{"topic":"عنوان البحث بالعربي","queries":["3-4 عبارات بحث قصيرة بالإنكليزي للمكتبات العلمية"],"ar_query":"عبارة بحث بالعربي","field":"medical|tech|science|social|general","drugs":["أسماء أدوية بالإنكليزي إذا الموضوع عن أدوية، وإلا قائمة فارغة"],"outline":["4-7 عناوين محاور التقرير"]}`;

const WRITER = `إنت باحث أكاديمي محترف تكتب لـ YAR AI. اكتب تقرير/سمينار علمي متكامل بالعربي الفصيح (إلا إذا المستخدم طلب لغة ثانية).
قواعد صارمة:
- اعتمد فقط على المصادر المرقّمة المعطاة. كل معلومة مهمة لازم يكون بعدها رقم مصدرها بين قوسين مربعين مثل [3] أو [2][5].
- لا تخترع أي مصدر أو رقم أو إحصائية أو اسم. إذا المصادر ما تغطي نقطة، گول بوضوح إنها تحتاج بحث إضافي.
- البنية: # عنوان، ثم ## المقدمة، ثم المحاور (##)، ثم ## الخلاصة والتوصيات. استخدم جداول عند المقارنة.
- لا تكتب قائمة المراجع بنفسك، راح تنضاف أوتوماتيكياً.`;

function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "سجّل دخول أول" }, 401);

    const { conversation_id, message, category } = await req.json();
    const text = String(message ?? "").trim().slice(0, 4000);
    if (!text) return json({ error: "اكتب موضوع البحث" }, 400);

    // البحث العميق يحسب ٣ رسائل من الحد اليومي
    const { data: planId } = await admin.rpc("effective_plan", { p_user: user.id });
    const { data: plan } = await admin.from("plans").select("*").eq("id", planId ?? "free").single();
    const limit = plan?.daily_limit ?? 15;
    let used = 0;
    for (let i = 0; i < 3; i++) {
      const { data } = await admin.rpc("bump_usage", { p_user: user.id, p_limit: limit });
      if (data === -1) return json({ error: `البحث العميق يحتاج ٣ رسائل من رصيدك اليومي، وما يكفي رصيدك. اشترك بباقة أعلى أو ارجع باچر.`, upgrade: true }, 429);
      used = data;
    }

    let convId = conversation_id, cat = "general";
    if (!convId) {
      const { data: okCat } = await admin.from("categories").select("id").eq("id", category ?? "general").maybeSingle();
      cat = okCat?.id ?? "general";
      const { data: c } = await admin.from("conversations").insert({ user_id: user.id, title: ("🔎 " + text).slice(0, 40), category: cat }).select("id").single();
      convId = c!.id;
    } else {
      const { data: c } = await admin.from("conversations").select("id,category").eq("id", convId).eq("user_id", user.id).maybeSingle();
      if (!c) return json({ error: "المحادثة مو موجودة" }, 404);
      cat = c.category;
    }

    const enc = new TextEncoder();
    const body = new ReadableStream({
      async start(ctrl) {
        const send = (o: unknown) => { try { ctrl.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`)); } catch { /* */ } };
        send({ conversation_id: convId });
        try {
          send({ status: "🧭 يخطط للبحث…" });
          let plan2: { topic?: string; queries?: string[]; ar_query?: string; field?: string; drugs?: string[]; outline?: string[] } = {};
          try { plan2 = JSON.parse((await gemini(PLANNER, text, { json: true })).text.replace(/^```(?:json)?|```$/g, "")); } catch { plan2 = { queries: [text], outline: [] }; }
          const qs = (plan2.queries?.length ? plan2.queries : [text]).slice(0, 4);

          send({ status: "📚 يبحث بـ OpenAlex و Semantic Scholar و PubMed و CrossRef…" });
          const jobs: Promise<Src[]>[] = [];
          qs.slice(0, 3).forEach((q) => jobs.push(openAlex(q), semanticScholar(q)));
          jobs.push(crossref(qs[0]));
          if (["medical", "science", "general", "social"].includes(plan2.field ?? "general")) qs.slice(0, 2).forEach((q) => jobs.push(pubmed(q)));
          if (["tech", "science"].includes(plan2.field ?? "")) jobs.push(arxiv(qs[0]));
          jobs.push(wikipedia(qs[0], "en"), wikipedia(plan2.ar_query || text, "ar"), tavily(qs[0]), exa(qs[0]));
          (plan2.drugs ?? []).slice(0, 3).forEach((d) => jobs.push(openFDA(d)));
          const web = gemini("ابحث بالإنترنت ولخّص أحدث وأهم المعلومات الموثوقة عن الموضوع بنقاط، ويا أرقام إذا موجودة. اذكر بس اللي لگيته.", plan2.topic || text, { search: true }).catch(() => null);
          const all = (await Promise.all(jobs)).flat();

          // دمج وإزالة التكرار، وترتيب حسب وجود الملخص والاستشهادات
          const seen = new Set<string>(); const papers: Src[] = [];
          for (const s of all) {
            if (!s.title || s.title.length < 6) continue;
            const key = (s.doi?.toLowerCase() || s.title.toLowerCase().replace(/[^a-z0-9؀-ۿ]/g, "").slice(0, 60));
            if (seen.has(key)) continue; seen.add(key); papers.push(s);
          }
          const scholarly = papers.filter((s) => !["Wikipedia", "Web", "openFDA"].includes(s.kind) && s.abstract)
            .sort((a, b) => (b.cites ?? 0) - (a.cites ?? 0)).slice(0, 14);
          const other = papers.filter((s) => ["Wikipedia", "Web", "openFDA"].includes(s.kind) && s.abstract).slice(0, 5);
          const srcs = [...scholarly, ...other];
          const w = await web;
          if (w) for (const x of w.web.slice(0, 5)) srcs.push({ kind: "Google", title: x.title, authors: [x.title], url: x.uri, abstract: "" });

          send({ status: `📖 لگى ${srcs.length} مصدر — يقرا البحوث المفتوحة كاملة…` });
          // نجيب PDF مفتوح (Unpaywall) ونقرا أهم بحثين كاملين (Jina Reader)
          await Promise.all(scholarly.slice(0, 6).map(async (s) => { if (!s.pdf && s.doi) s.pdf = await unpaywall(s.doi); }));
          await Promise.all(scholarly.filter((s) => s.pdf).slice(0, 2).map(async (s) => { s.body = await jinaRead(s.pdf!); }));

          if (srcs.length < 2) throw new Error("NO_SOURCES");
          const ctx = srcs.map((s, i) => `[${i + 1}] (${s.kind}) ${s.title} — ${s.authors.slice(0, 3).join(", ")} (${s.year ?? "n.d."})${s.venue ? " — " + s.venue : ""}\n${s.abstract || ""}${s.body ? "\nمقتطف من النص الكامل: " + s.body.slice(0, 3000) : ""}`).join("\n\n")
            + (w ? `\n\n[ملخص بحث Google — المصادر ${scholarly.length + other.length + 1} وما بعدها]\n${w.text}` : "");

          send({ status: "✍️ يكتب التقرير…" });
          const report = await geminiStream(WRITER, `طلب المستخدم: ${text}\n\nالمحاور المقترحة: ${(plan2.outline ?? []).join(" | ")}\n\nالمصادر:\n${ctx}`, (t) => send({ t }));
          const refs = `\n\n---\n## المراجع\n${srcs.map((s, i) => apa(s, i + 1)).join("\n")}\n\n<sub>🔎 بحث عميق من YAR AI — المصادر: OpenAlex · Semantic Scholar · PubMed · CrossRef · arXiv · Wikipedia · openFDA · Google. راجع المصادر الأصلية قبل الاعتماد النهائي.</sub>`;
          const final = report + refs;
          send({ t: refs });

          await admin.from("messages").insert([
            { conversation_id: convId, user_id: user.id, role: "user", content: `🔎 بحث عميق: ${text}` },
            { conversation_id: convId, user_id: user.id, role: "assistant", content: final },
          ]);
          await admin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", convId);
          send({ done: true, reply: final, conversation_id: convId, category: cat, remaining: limit - (used ?? 0), sources: srcs.length });
        } catch (e) {
          console.error(String(e));
          send({ error: String((e as Error).message) === "NO_SOURCES" ? "ما لگيت مصادر كافية لهذا الموضوع. جرّب تكتبه بشكل أوضح أو بالإنكليزي." : "صار خلل بالبحث، جرّب مرة ثانية" });
        }
        ctrl.close();
      },
    });
    return new Response(body, { headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
  } catch (e) {
    console.error(String(e));
    return json({ error: "صار خلل مؤقت، جرّب مرة ثانية" }, 500);
  }
});
