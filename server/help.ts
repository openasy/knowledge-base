// The public help center: plain HTML pages made on the server, with one small stylesheet and no script of their own,
// so they are fast, work without JavaScript and read well with a screen reader. Every text is escaped; article bodies
// were sanitized when written and are sanitized again before they are shown (content.ts). Pages are at
// /<lang>/, /<lang>/topics/<slug>, /<lang>/articles/<slug> and /<lang>/search?q=, under the help center's base.
import type { IncomingMessage, ServerResponse } from "node:http";
import { PLACES } from "./config.ts";
import type { Found, KnowledgeBase } from "./kb.ts";

type Words = Record<string, string>;

const EN: Words = {
  skip: "Skip to content",
  languages: "Language",
  searchLabel: "Search the help center",
  searchPlaceholder: "Describe your question",
  search: "Search",
  hero: "How can we help?",
  popular: "Popular articles",
  topics: "Topics",
  other: "Other articles",
  count: "{n} articles",
  countOne: "1 article",
  emptyTopic: "No articles in this topic yet.",
  empty: "No articles yet.",
  breadcrumb: "Breadcrumb",
  results: 'Results for "{q}"',
  nothing: 'Nothing found for "{q}".',
  nothingHint: "Try other or fewer words. The team sees searches that found nothing and writes the missing articles.",
  enterWords: "Type a few words about your question.",
  didHelp: "Did this help?",
  yes: "Yes",
  no: "No",
  thanks: "Thank you. Your answer helps the team improve this article.",
  updated: "Updated {date}",
  related: "More in {topic}",
  fallback: "This article is not in {lang} yet, so it is shown in {other}.",
  planOnly: "This article is for customers on some plans",
  planOnlyText: "Open it from your account in the app, and it opens here for you.",
  forPlans: "For customers on {plans}",
  notFound: "This page is not here",
  notFoundText: "It may have moved or been taken down. Try the search instead.",
  expired: "This link has ended",
  expiredText: "Open the help center again from your account in the app.",
  home: "Help center home",
  suggestHeading: "These may answer it",
  suggestHelpful: "{n}% found it helpful",
};

const DE: Words = {
  skip: "Zum Inhalt springen",
  languages: "Sprache",
  searchLabel: "Im Hilfe-Center suchen",
  searchPlaceholder: "Beschreiben Sie Ihre Frage",
  search: "Suchen",
  hero: "Wie können wir helfen?",
  popular: "Beliebte Artikel",
  topics: "Themen",
  other: "Weitere Artikel",
  count: "{n} Artikel",
  countOne: "1 Artikel",
  emptyTopic: "Zu diesem Thema gibt es noch keine Artikel.",
  empty: "Noch keine Artikel.",
  breadcrumb: "Brotkrumen",
  results: "Ergebnisse für „{q}“",
  nothing: "Nichts gefunden für „{q}“.",
  nothingHint: "Versuchen Sie andere oder weniger Wörter. Das Team sieht Suchen ohne Ergebnis und schreibt die fehlenden Artikel.",
  enterWords: "Geben Sie ein paar Wörter zu Ihrer Frage ein.",
  didHelp: "Hat das geholfen?",
  yes: "Ja",
  no: "Nein",
  thanks: "Danke. Ihre Antwort hilft dem Team, diesen Artikel zu verbessern.",
  updated: "Aktualisiert am {date}",
  related: "Mehr zu {topic}",
  fallback: "Diesen Artikel gibt es noch nicht auf {lang}, daher wird er auf {other} gezeigt.",
  planOnly: "Dieser Artikel ist für Kunden bestimmter Tarife",
  planOnlyText: "Öffnen Sie ihn aus Ihrem Konto in der App, dann öffnet er sich hier für Sie.",
  forPlans: "Für Kunden mit {plans}",
  notFound: "Diese Seite gibt es hier nicht",
  notFoundText: "Sie wurde vielleicht verschoben oder entfernt. Versuchen Sie stattdessen die Suche.",
  expired: "Dieser Link ist abgelaufen",
  expiredText: "Öffnen Sie das Hilfe-Center erneut aus Ihrem Konto in der App.",
  home: "Startseite des Hilfe-Centers",
  suggestHeading: "Das könnte Ihre Frage beantworten",
  suggestHelpful: "{n}% fanden es hilfreich",
};

const TR: Words = {
  skip: "İçeriğe geç",
  languages: "Dil",
  searchLabel: "Yardım merkezinde ara",
  searchPlaceholder: "Sorunuzu yazın",
  search: "Ara",
  hero: "Size nasıl yardımcı olabiliriz?",
  popular: "Çok okunanlar",
  topics: "Konular",
  other: "Diğer makaleler",
  count: "{n} makale",
  countOne: "1 makale",
  emptyTopic: "Bu konuda henüz makale yok.",
  empty: "Henüz makale yok.",
  breadcrumb: "Sayfa yolu",
  results: '"{q}" için sonuçlar',
  nothing: '"{q}" için bir şey bulunamadı.',
  nothingHint: "Başka ya da daha az kelimeyle deneyin. Ekip sonuç bulamayan aramaları görür ve eksik makaleleri yazar.",
  enterWords: "Sorunuzla ilgili birkaç kelime yazın.",
  didHelp: "Bu yardımcı oldu mu?",
  yes: "Evet",
  no: "Hayır",
  thanks: "Teşekkürler. Yanıtınız ekibin bu makaleyi iyileştirmesine yardım eder.",
  updated: "{date} tarihinde güncellendi",
  related: "{topic} konusunda diğerleri",
  fallback: "Bu makale henüz {lang} dilinde yok, bu yüzden {other} dilinde gösteriliyor.",
  planOnly: "Bu makale belirli paketlerdeki müşteriler içindir",
  planOnlyText: "Uygulamadaki hesabınızdan açın, burada sizin için açılır.",
  forPlans: "{plans} müşterileri için",
  notFound: "Bu sayfa burada değil",
  notFoundText: "Taşınmış ya da kaldırılmış olabilir. Bunun yerine aramayı deneyin.",
  expired: "Bu bağlantının süresi doldu",
  expiredText: "Yardım merkezini uygulamadaki hesabınızdan yeniden açın.",
  home: "Yardım merkezi ana sayfası",
  suggestHeading: "Bunlar sorunuzu yanıtlayabilir",
  suggestHelpful: "%{n} yararlı buldu",
};

const WORDS: Record<string, Words> = { en: EN, de: DE, tr: TR };

/** The help center's own words in a language: English, German and Turkish, English for the others. */
export function words(lang: string) {
  const w = WORDS[lang.slice(0, 2)] ?? EN;
  return (key: keyof typeof EN, vars: Record<string, string | number> = {}) =>
    (w[key] ?? EN[key]!).replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** Text and attribute values, escaped for HTML. */
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);

/** A language's name in that language: Türkçe, English, Deutsch. */
export function languageName(code: string, inLang = code) {
  try {
    const name = new Intl.DisplayNames([inLang], { type: "language" }).of(code) ?? code;
    return name.charAt(0).toLocaleUpperCase(inLang) + name.slice(1);
  } catch {
    return code;
  }
}

/** The reader's language from Accept-Language, among the help center's, or the default one. */
export function negotiate(header: string | undefined, languages: string[], fallback: string): string {
  const wanted = (header ?? "")
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const qv = params.map((p) => /^\s*q=([\d.]+)/.exec(p)).find(Boolean);
      return { tag: (tag ?? "").toLowerCase(), q: qv ? Number(qv[1]) : 1 };
    })
    .filter((x) => x.tag && x.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const w of wanted) {
    const exact = languages.find((l) => l.toLowerCase() === w.tag);
    if (exact) return exact;
    const prefix = languages.find((l) => l.toLowerCase().split("-")[0] === w.tag.split("-")[0]);
    if (prefix) return prefix;
  }
  return fallback;
}

const BOT = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|curl|wget|python-requests|go-http-client/i;

export interface HelpOptions {
  kb: KnowledgeBase;
  /** #rrggbb from the install's brand, for links and buttons. */
  accent?: string;
}

const READER_COOKIE = "kb_reader";

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** The stylesheet: light and dark, readable widths, visible focus. */
export function stylesheet(accent = "#2563eb") {
  const a = /^#[0-9a-f]{6}$/i.test(accent) ? accent : "#2563eb";
  return `:root{--accent:${a};--bg:#fff;--fg:#1f2328;--muted:#59636e;--line:#d1d9e0;--soft:#f6f8fa;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--line:#3d444d;--soft:#151b23}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",sans-serif}
a{color:var(--accent);text-underline-offset:.15em}a:hover{text-decoration-thickness:2px}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.skip{position:absolute;left:-999px;top:0;background:var(--bg);padding:.5rem 1rem}.skip:focus{left:1rem}
.wrap{max-width:52rem;margin:0 auto;padding:0 1rem}
header.top{border-bottom:1px solid var(--line)}header.top .wrap{display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:center;justify-content:space-between;padding-block:.75rem}
.brand{font-weight:600;color:var(--fg);text-decoration:none;font-size:1.05rem}
nav.langs ul{display:flex;gap:.75rem;list-style:none;margin:0;padding:0;font-size:.9rem}nav.langs [aria-current]{color:var(--fg);font-weight:600;text-decoration:none}
main{padding-block:1.5rem 3rem}h1{font-size:1.75rem;line-height:1.25;margin:.25rem 0 1rem}h2{font-size:1.25rem;margin:1.75rem 0 .5rem}h3{font-size:1.05rem}
form.search{display:flex;gap:.5rem;margin:0 0 1.5rem}form.search label{position:absolute;left:-999px}
form.search input{flex:1;min-width:0;font:inherit;padding:.6rem .75rem;border:1px solid var(--line);border-radius:.5rem;background:var(--bg);color:var(--fg)}
button{font:inherit;padding:.55rem 1rem;border-radius:.5rem;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer}
button.plain{background:transparent;color:var(--fg);border-color:var(--line)}
.hero{padding-block:1rem .25rem}.hero h1{font-size:2rem}
.topics{display:grid;gap:1rem;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));list-style:none;padding:0;margin:0}
.topics>li{border:1px solid var(--line);border-radius:.75rem;padding:1rem}.topics h2,.topics h3{margin:0 0 .25rem;font-size:1.05rem}
.muted{color:var(--muted);font-size:.9rem}
ul.articles{list-style:none;padding:0;margin:0}ul.articles li{padding:.6rem 0;border-bottom:1px solid var(--line)}ul.articles li:last-child{border:0}
ul.articles p{margin:.15rem 0 0;color:var(--muted);font-size:.9rem}
nav.crumbs ol{display:flex;flex-wrap:wrap;gap:.25rem;list-style:none;padding:0;margin:0;font-size:.9rem}nav.crumbs li+li:before{content:"/";margin-right:.25rem;color:var(--muted)}
.note{background:var(--soft);border:1px solid var(--line);border-radius:.5rem;padding:.6rem .8rem;margin:0 0 1rem}
.body{overflow-wrap:anywhere}.body img{max-width:100%;height:auto}.body pre{background:var(--soft);padding:.75rem;border-radius:.5rem;overflow:auto}
.body code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}.body table{border-collapse:collapse;display:block;overflow:auto}
.body th,.body td{border:1px solid var(--line);padding:.35rem .6rem;text-align:left}.body blockquote{margin:0;padding-left:1rem;border-left:3px solid var(--line);color:var(--muted)}
.helpful{margin-top:2rem;padding-top:1rem;border-top:1px solid var(--line)}.helpful fieldset{border:0;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
.helpful legend{font-weight:600;margin-right:.5rem;float:left}
footer{border-top:1px solid var(--line);padding-block:1rem;color:var(--muted);font-size:.85rem}
`;
}

interface Page {
  lang: string;
  title: string;
  description?: string;
  body: string;
  /** Other languages of this page, for hreflang and the language links. */
  alternates?: Array<{ lang: string; href: string }>;
  status?: number;
  noindex?: boolean;
}

export function createHelpCenter({ kb, accent }: HelpOptions) {
  const css = stylesheet(accent);
  const votes = new Map<string, number>();

  function page(base: string, p: Page) {
    const c = kb.config()!;
    const t = words(p.lang);
    const langs = p.alternates ?? c.site.languages.map((l) => ({ lang: l, href: `${base}/${l}/` }));
    const analytics = c.site.analytics;
    return `<!doctype html>
<html lang="${esc(p.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title === c.site.name ? p.title : `${p.title} · ${c.site.name}`)}</title>
${p.description ? `<meta name="description" content="${esc(p.description)}">\n` : ""}${p.noindex ? '<meta name="robots" content="noindex">\n' : ""}<link rel="stylesheet" href="${base}/assets/help.css">
${langs.map((l) => `<link rel="alternate" hreflang="${esc(l.lang)}" href="${esc(l.href)}">`).join("\n")}
${analytics ? `<script defer src="${esc(analytics)}"></script>\n` : ""}</head>
<body>
<a class="skip" href="#main">${esc(t("skip"))}</a>
<header class="top"><div class="wrap">
<a class="brand" href="${base}/${esc(p.lang)}/">${esc(c.site.name)}</a>
${
  c.site.languages.length > 1
    ? `<nav class="langs" aria-label="${esc(t("languages"))}"><ul>${c.site.languages
        .map((l) => {
          const href = langs.find((x) => x.lang === l)?.href ?? `${base}/${l}/`;
          return `<li><a href="${esc(href)}" hreflang="${esc(l)}" lang="${esc(l)}"${l === p.lang ? ' aria-current="true"' : ""}>${esc(languageName(l))}</a></li>`;
        })
        .join("")}</ul></nav>`
    : ""
}
</div></header>
<main id="main" class="wrap">
${p.body}
</main>
<footer><div class="wrap"><a href="${base}/${esc(p.lang)}/">${esc(t("home"))}</a></div></footer>
</body>
</html>
`;
  }

  const searchForm = (base: string, lang: string, value = "") => {
    const t = words(lang);
    return `<form class="search" role="search" action="${base}/${esc(lang)}/search" method="get">
<label for="q">${esc(t("searchLabel"))}</label>
<input type="search" id="q" name="q" value="${esc(value)}" placeholder="${esc(t("searchPlaceholder"))}" maxlength="200" autocomplete="off">
<button type="submit">${esc(t("search"))}</button>
</form>`;
  };

  const topicName = (slug: string | null, lang: string) => {
    const tp = kb.config()!.topics.find((x) => x.slug === slug);
    return tp ? (tp.names[lang] ?? tp.name) : null;
  };

  const articleList = (base: string, lang: string, items: Found[], extra = "", excerpts = true) =>
    `<ul class="articles">${items
      .map(
        (a) =>
          `<li><a href="${base}/${esc(lang)}/articles/${esc(a.slug)}${extra}"${a.lang !== lang ? ` hreflang="${esc(a.lang)}"` : ""}><span${a.lang !== lang ? ` lang="${esc(a.lang)}"` : ""}>${esc(a.title)}</span></a>${
            excerpts && a.excerpt ? `<p${a.lang !== lang ? ` lang="${esc(a.lang)}"` : ""}>${esc(a.excerpt)}</p>` : ""
          }</li>`,
      )
      .join("")}</ul>`;

  function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
    const analytics = kb.config()?.site.analytics;
    const script = analytics ? new URL(analytics).origin : "'none'";
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-frame-options": "DENY",
      // No inline script anywhere; article images may come from any https address.
      "content-security-policy": `default-src 'none'; style-src 'self'; img-src 'self' https: data:; script-src ${script}; connect-src ${script}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      ...headers,
    });
    res.end(body);
  }

  const notFound = (res: ServerResponse, base: string, lang: string) => {
    const t = words(lang);
    send(
      res,
      404,
      page(base, {
        lang,
        title: t("notFound"),
        noindex: true,
        body: `<h1>${esc(t("notFound"))}</h1><p>${esc(t("notFoundText"))}</p>${searchForm(base, lang)}`,
      }),
    );
  };

  /** Where a reader came from, for the views: a suggestion's place, the search, this help center, or another site. */
  function source(req: IncomingMessage, url: URL) {
    const from = url.searchParams.get("from");
    if (from && ((PLACES as readonly string[]).includes(from) || from === "search")) return from;
    const ref = URL.parse(req.headers.referer ?? "");
    if (!ref) return "direct";
    if (ref.host === req.headers.host) return "internal";
    return ref.hostname.replace(/^www\./, "");
  }

  async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > 4096) break;
      chunks.push(chunk);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  }

  /**
   * Answers a request for the help center. `path` is relative to `base` ("" when the help center has its own address,
   * "/help" otherwise). Returns the route name, for metrics.
   */
  async function handle(req: IncomingMessage, res: ServerResponse, base: string, path: string, url: URL, secure: boolean): Promise<string> {
    const c = kb.config();
    if (!c) {
      send(res, 503, "<!doctype html><title>Help center</title><p>The help center is starting.</p>");
      return "help";
    }
    const def = c.site.defaultLanguage;
    if (path === "/assets/help.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff" });
      res.end(css);
      return "help/assets";
    }
    if (path === "" || path === "/") {
      const lang = negotiate(req.headers["accept-language"], c.site.languages, def);
      res.writeHead(302, { location: `${base}/${lang}/`, vary: "Accept-Language" }).end();
      return "help";
    }
    const plans = kb.readReader(cookie(req, READER_COOKIE))?.plans ?? [];

    if (path === "/reader") {
      // A reader link from the customer's app: the token goes in a cookie for this help center, and the reader on.
      const token = url.searchParams.get("token");
      const reader = kb.readReader(token);
      const lang = negotiate(req.headers["accept-language"], c.site.languages, def);
      if (!reader) {
        const t = words(lang);
        send(
          res,
          400,
          page(base, {
            lang,
            title: t("expired"),
            noindex: true,
            body: `<h1>${esc(t("expired"))}</h1><p>${esc(t("expiredText"))}</p>${searchForm(base, lang)}`,
          }),
        );
        return "help/reader";
      }
      const to = url.searchParams.get("to") ?? "";
      const next = to.startsWith("/") && !to.startsWith("//") && !to.includes("\\") ? `${base}${to}` : `${base}/${lang}/`;
      const maxAge = Math.max(0, reader.exp - Math.floor(kb.now() / 1000));
      res
        .writeHead(303, {
          location: next,
          "set-cookie": `${READER_COOKIE}=${encodeURIComponent(token!)}; Path=${base || "/"}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        })
        .end();
      return "help/reader";
    }

    const m = /^\/([a-zA-Z-]{2,8})(\/.*)?$/.exec(path);
    const lang = m && c.site.languages.includes(m[1]!) ? m[1]! : null;
    if (!lang) {
      notFound(res, base, def);
      return "help";
    }
    const rest = m![2] ?? "/";
    const t = words(lang);
    const private_ = plans.length > 0 ? { "cache-control": "private, no-store" } : { "cache-control": "public, max-age=60" };

    if (rest === "/" && (req.method === "GET" || req.method === "HEAD")) {
      const { topics, other, popular } = kb.topics(lang, plans);
      const count = (n: number) => (n === 1 ? t("countOne") : t("count", { n }));
      const body = `<div class="hero"><h1>${esc(t("hero"))}</h1></div>
${searchForm(base, lang)}
${popular.length ? `<section aria-labelledby="popular"><h2 id="popular">${esc(t("popular"))}</h2>${articleList(base, lang, popular)}</section>` : `<p>${esc(t("empty"))}</p>`}
${
  topics.length
    ? `<section aria-labelledby="topics"><h2 id="topics">${esc(t("topics"))}</h2><ul class="topics">${topics
        .map(
          (tp) =>
            `<li><h3><a href="${base}/${esc(lang)}/topics/${esc(tp.slug)}">${esc(tp.name)}</a></h3><p class="muted">${esc(count(tp.articles.length))}</p>${
              tp.articles.length ? articleList(base, lang, tp.articles.slice(0, 3), "", false) : ""
            }</li>`,
        )
        .join("")}</ul></section>`
    : ""
}
${other.length ? `<section aria-labelledby="other"><h2 id="other">${esc(t("other"))}</h2>${articleList(base, lang, other)}</section>` : ""}`;
      send(res, 200, page(base, { lang, title: c.site.name, alternates: c.site.languages.map((l) => ({ lang: l, href: `${base}/${l}/` })), body }), private_);
      return "help/home";
    }

    const topic = /^\/topics\/([a-z0-9-]{1,64})$/.exec(rest);
    if (topic && (req.method === "GET" || req.method === "HEAD")) {
      const all = kb.topics(lang, plans);
      const tp = all.topics.find((x) => x.slug === topic[1]);
      if (!tp) return (notFound(res, base, lang), "help/topic");
      const body = `<nav class="crumbs" aria-label="${esc(t("breadcrumb"))}"><ol><li><a href="${base}/${esc(lang)}/">${esc(c.site.name)}</a></li><li><a href="${base}/${esc(lang)}/topics/${esc(tp.slug)}" aria-current="page">${esc(tp.name)}</a></li></ol></nav>
<h1>${esc(tp.name)}</h1>
${searchForm(base, lang)}
${tp.articles.length ? articleList(base, lang, tp.articles) : `<p>${esc(t("emptyTopic"))}</p>`}`;
      send(
        res,
        200,
        page(base, { lang, title: tp.name, alternates: c.site.languages.map((l) => ({ lang: l, href: `${base}/${l}/topics/${tp.slug}` })), body }),
        private_,
      );
      return "help/topic";
    }

    if (rest === "/search" && (req.method === "GET" || req.method === "HEAD")) {
      const text = (url.searchParams.get("q") ?? "").slice(0, 200);
      const found = text.trim() ? kb.search(text, lang, plans, 20) : [];
      // Each search is kept with what it found: those that found nothing are the team's list of gaps.
      const id =
        req.method === "GET" && text.trim() && !BOT.test(req.headers["user-agent"] ?? "") ? kb.recordSearch("help-center", lang, text, found.length) : null;
      const extra = `?from=search${id ? `&amp;s=${esc(id)}` : ""}`;
      const body = `<h1>${esc(text.trim() ? t("results", { q: text.trim() }) : t("search"))}</h1>
${searchForm(base, lang, text)}
${
  !text.trim()
    ? `<p>${esc(t("enterWords"))}</p>`
    : found.length
      ? articleList(base, lang, found, extra)
      : `<p role="status"><strong>${esc(t("nothing", { q: text.trim() }))}</strong></p><p>${esc(t("nothingHint"))}</p>`
}`;
      send(res, 200, page(base, { lang, title: t("search"), noindex: true, body }), { "cache-control": "no-store" });
      return "help/search";
    }

    const art = /^\/articles\/([a-z0-9-]{1,80})(\/vote)?$/.exec(rest);
    if (art) {
      const a = kb.article(art[1]!, lang, plans);
      if (!a) return (notFound(res, base, lang), "help/article");
      if (a.kind === "plan") {
        send(
          res,
          403,
          page(base, {
            lang,
            title: t("planOnly"),
            noindex: true,
            body: `<h1>${esc(t("planOnly"))}</h1><p>${esc(t("planOnlyText"))}</p>${searchForm(base, lang)}`,
          }),
          {
            "cache-control": "no-store",
          },
        );
        return "help/article";
      }
      const self = `${base}/${lang}/articles/${a.slug}`;
      if (art[2]) {
        if (req.method !== "POST") return (notFound(res, base, lang), "help/vote");
        const form = await readForm(req);
        const helpful = form.get("helpful");
        // One answer an article from the same address every ten minutes; addresses are kept in memory only.
        const key = `${req.socket.remoteAddress}|${a.id}`;
        const last = votes.get(key);
        if ((helpful === "yes" || helpful === "no") && !(last && Date.now() - last < 600_000)) {
          kb.vote(a.id, a.lang, helpful === "yes");
          votes.set(key, Date.now());
          if (votes.size > 50_000) for (const [k, at] of votes) if (Date.now() - at > 600_000) votes.delete(k);
        }
        res.writeHead(303, { location: `${self}?voted=1#helpful`, "cache-control": "no-store" }).end();
        return "help/vote";
      }
      if (req.method !== "GET" && req.method !== "HEAD") return (notFound(res, base, lang), "help/article");
      const ua = req.headers["user-agent"] ?? "";
      const prefetch = /prefetch|prerender/i.test(String(req.headers["sec-purpose"] ?? req.headers.purpose ?? ""));
      if (req.method === "GET" && !BOT.test(ua) && !prefetch && url.searchParams.get("voted") !== "1")
        kb.recordView(a.id, a.lang, source(req, url), url.searchParams.get("s") ?? undefined);
      const tname = topicName(a.topic, lang);
      const date = new Intl.DateTimeFormat(lang, { dateStyle: "long" }).format(new Date(a.updatedAt!));
      const planNames = a.plans.map((p) => c.plans.find((x) => x.id === p)?.name ?? p).join(", ");
      const voted = url.searchParams.get("voted") === "1";
      const body = `<nav class="crumbs" aria-label="${esc(t("breadcrumb"))}"><ol><li><a href="${base}/${esc(lang)}/">${esc(c.site.name)}</a></li>${
        tname ? `<li><a href="${base}/${esc(lang)}/topics/${esc(a.topic!)}">${esc(tname)}</a></li>` : ""
      }</ol></nav>
<article lang="${esc(a.lang)}">
<h1>${esc(a.title)}</h1>
${a.lang !== lang ? `<p class="note" lang="${esc(lang)}">${esc(t("fallback", { lang: languageName(lang, lang), other: languageName(a.lang, lang) }))}</p>` : ""}${
        a.plans.length ? `<p class="note" lang="${esc(lang)}">${esc(t("forPlans", { plans: planNames }))}</p>` : ""
      }<p class="muted" lang="${esc(lang)}">${esc(t("updated", { date }))}</p>
<div class="body">
${a.html}
</div>
</article>
<section class="helpful" id="helpful" aria-labelledby="helpful-q">
${
  voted
    ? `<p id="helpful-q" role="status">${esc(t("thanks"))}</p>`
    : `<form method="post" action="${esc(self)}/vote"><fieldset><legend id="helpful-q">${esc(t("didHelp"))}</legend><button type="submit" name="helpful" value="yes">${esc(t("yes"))}</button><button type="submit" name="helpful" value="no" class="plain">${esc(t("no"))}</button></fieldset></form>`
}
</section>
${a.related.length && tname ? `<section aria-labelledby="related"><h2 id="related">${esc(t("related", { topic: tname }))}</h2>${articleList(base, lang, a.related)}</section>` : ""}`;
      send(
        res,
        200,
        page(base, {
          lang,
          title: a.title,
          alternates: c.site.languages.map((l) => ({ lang: l, href: `${base}/${l}/articles/${a.slug}` })),
          body,
          noindex: a.plans.length > 0,
        }),
        a.plans.length ? { "cache-control": "private, no-store" } : { "cache-control": "no-cache" },
      );
      return "help/article";
    }

    notFound(res, base, lang);
    return "help";
  }

  return { handle };
}
