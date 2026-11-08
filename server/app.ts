import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AuthError, identityOrigin, mergeOpenApi, sendProblem, type Auth, type Role } from "@openasy/auth";
import { createHelpCenter, words } from "./help.ts";
import { KbError, parseRange, type Actor, type Found, type KnowledgeBase, type ProblemCode } from "./kb.ts";
import { log } from "./log.ts";
import { countRequest, renderMetrics } from "./metrics.ts";
import type { ProductLink } from "./products.ts";

export interface AppOptions {
  db: DatabaseSync;
  kb: KnowledgeBase;
  version: string;
  /** The address people open the product at; the help center is at <publicUrl>/help unless the file gives it its own. */
  publicUrl: string;
  /** Sign-in, sessions, members and API tokens (ADR 0002, 0003). */
  auth: Auth;
  /** For tests and local scripts: one shared token with the admin role. main.ts never sets it. */
  adminToken?: string;
  /** The built suggest script (dist/suggest/suggest.js), served with the settings at /s/suggest.js. */
  suggestScript?: string;
  /** #rrggbb from the install's brand, for the help center. */
  accent?: string;
  /** Built web UI; omit to run headless (ADR 0018). */
  webDir?: string;
  /** Built API reference (Swagger UI), served at /api/docs. */
  docsDir?: string;
  /** The OpenAPI description, served at /api/openapi.json with this release's version. */
  openapi?: Record<string, unknown>;
  /** false when /metrics is served on its own port instead (ADR 0026). */
  serveMetrics?: boolean;
  /** The install's OpenAsy products and their addresses, from OPENASY_PRODUCTS, for the product switcher. */
  products?: ProductLink[];
}

function metricsText(kb: KnowledgeBase, version: string) {
  return renderMetrics(version, { ...kb.gauges(), fileError: !!kb.settings().file?.error });
}

/** Serves only /metrics, for a port that is not exposed with the rest (KNOWLEDGE_BASE_METRICS_PORT). */
export function createMetricsHandler(kb: KnowledgeBase, version: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/metrics") return problem(res, 404, "not-found");
    send(res, 200, metricsText(kb, version), "text/plain; version=0.0.4");
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Identity keeps people's theme and language when they sign in through it; the pages read them there (ADR 0033).
const IDENTITY = identityOrigin(process.env);

/** The team's pages run nothing from elsewhere. Article previews may show images from any https address. */
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": `default-src 'self'; connect-src 'self'${IDENTITY ? ` ${IDENTITY}` : ""}; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-ancestors 'none'`,
};

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json", headers: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown, headers?: Record<string, string>) =>
  send(res, status, JSON.stringify(data), "application/json", headers);

const TITLES: Record<ProblemCode, string> = {
  "invalid-token": "Invalid token",
  "invalid-json": "Invalid JSON",
  "invalid-body": "Invalid request body",
  "forbidden-origin": "Origin not allowed",
  "not-found": "Not found",
  conflict: "Conflict",
  "rate-limited": "Too many requests",
  "payload-too-large": "Payload too large",
  "internal-error": "Internal error",
};

/** RFC 9457 Problem Details (ADR 0024). `code` is the stable part clients match on. */
function problem(res: ServerResponse, status: number, code: ProblemCode, detail?: string, headers: Record<string, string> = {}) {
  const body = { type: `https://openasy.github.io/problems/${code}`, title: TITLES[code], status, code, ...(detail && { detail }) };
  send(res, status, JSON.stringify(body), "application/problem+json", headers);
}

/** Serves a file from dir, or returns false when the path is outside it or missing. */
async function serveFile(res: ServerResponse, dir: string, relative: string): Promise<boolean> {
  const file = normalize(join(dir, relative));
  if (!file.startsWith(normalize(dir)) || !extname(file)) return false;
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
    return true;
  } catch {
    return false;
  }
}

/** Reads a JSON body of up to `limit` bytes. */
async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new KbError(413, "payload-too-large", `The body must be at most ${Math.round(limit / 1024)} KiB.`);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new KbError(400, "invalid-json", "The body must be JSON.");
  }
}

function tokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The role a route needs (ADR 0003); "none" for the version and for the suggest API, which the sites call. */
type Access = "none" | Role;
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  who: Actor;
  body: () => Promise<unknown>;
}
interface Route {
  method: string;
  /** Path pattern; each `:name` matches one segment. */
  path: string;
  auth: Access;
  /** Largest JSON body taken, in bytes. Default 1 MiB. */
  limit?: number;
  handle: (ctx: Ctx) => unknown;
}

/** Calls to the suggest API a minute from one address. Counted in memory, never stored. */
const SUGGEST_RATE = 240;

export function createApp({
  db,
  kb,
  version,
  publicUrl,
  auth,
  adminToken,
  suggestScript,
  accent,
  webDir,
  docsDir,
  openapi,
  serveMetrics = true,
  products = [],
}: AppOptions) {
  // The served description includes /api/v1/auth from @openasy/auth, so the API reference documents sign-in too.
  const spec = openapi && JSON.stringify({ ...mergeOpenApi(openapi), info: { ...(openapi.info as object), version } });
  const help = createHelpCenter({ kb, accent });
  const noContent = (res: ServerResponse) => {
    res.writeHead(204, SECURITY_HEADERS).end();
  };
  const days = (url: URL) => parseRange(url.searchParams.get("days"));

  const routes: Route[] = [
    { method: "GET", path: "/api/v1/version", auth: "none", handle: () => ({ product: "knowledge-base", version }) },
    { method: "GET", path: "/api/v1/products", auth: "viewer", handle: () => ({ products }) },
    { method: "GET", path: "/api/v1/summary", auth: "viewer", handle: () => kb.summary() },
    // The settings, as the file sets them. There is no route that changes them.
    { method: "GET", path: "/api/v1/settings", auth: "viewer", handle: () => kb.settings() },
    { method: "GET", path: "/api/v1/team", auth: "viewer", handle: () => ({ members: kb.team() }) },

    // Articles: written, reviewed and published by the team.
    { method: "GET", path: "/api/v1/articles", auth: "viewer", handle: ({ url }) => ({ articles: kb.list(days(url)) }) },
    { method: "POST", path: "/api/v1/articles", auth: "editor", handle: async ({ res, who, body }) => json(res, 201, kb.create(who, await body())) },
    { method: "GET", path: "/api/v1/articles/:id", auth: "viewer", handle: ({ url, params }) => kb.get(params[0]!, days(url)) },
    { method: "PATCH", path: "/api/v1/articles/:id", auth: "editor", handle: async ({ who, params, body }) => kb.update(who, params[0]!, await body()) },
    { method: "DELETE", path: "/api/v1/articles/:id", auth: "editor", handle: ({ res, params }) => (kb.remove(params[0]!), noContent(res)) },
    { method: "POST", path: "/api/v1/articles/:id/submit", auth: "editor", handle: ({ who, params }) => kb.submit(who, params[0]!) },
    { method: "POST", path: "/api/v1/articles/:id/approve", auth: "editor", handle: ({ who, params }) => kb.approve(who, params[0]!) },
    {
      method: "POST",
      path: "/api/v1/articles/:id/send-back",
      auth: "editor",
      handle: async ({ who, params, body }) => {
        const b = await body();
        return kb.sendBack(who, params[0]!, (b as { note?: unknown }).note);
      },
    },
    { method: "POST", path: "/api/v1/articles/:id/unpublish", auth: "editor", handle: ({ params }) => kb.unpublish(params[0]!) },
    {
      method: "POST",
      path: "/api/v1/import",
      auth: "editor",
      limit: 16 * 1024 * 1024,
      handle: async ({ res, who, body }) => json(res, 201, kb.importFiles(who, await body())),
    },
    { method: "POST", path: "/api/v1/preview", auth: "editor", handle: async ({ body }) => kb.preview(await body()) },

    // Reports.
    { method: "GET", path: "/api/v1/report", auth: "viewer", handle: ({ url }) => kb.report(days(url)) },
    { method: "GET", path: "/api/v1/gaps", auth: "viewer", handle: ({ url }) => kb.gaps(days(url)) },
    { method: "POST", path: "/api/v1/gaps/dismiss", auth: "editor", handle: async ({ res, body }) => (kb.dismissGap(await body()), noContent(res)) },
    { method: "GET", path: "/api/v1/suggestions", auth: "viewer", handle: ({ url }) => kb.suggestions(days(url)) },

    // A reader link for plan-only articles, to try one or hand one out; the customer's app usually signs its own.
    {
      method: "POST",
      path: "/api/v1/reader-links",
      auth: "admin",
      handle: async ({ body }) => {
        const b = (await body()) as { plans?: unknown; minutes?: unknown; to?: unknown };
        const { token, expiresAt } = kb.signReader(b.plans as string[], (b.minutes as number | undefined) ?? 60);
        const to = typeof b.to === "string" && b.to.startsWith("/") && !b.to.startsWith("//") ? b.to : "/";
        return { token, expiresAt, url: `${kb.helpUrl()}/reader?${new URLSearchParams({ token, to })}` };
      },
    },
  ];

  const compiled = routes.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:[a-z]+/g, "([^/]+)")}$`) }));

  /** The origins whose pages may call the suggest API: the file's suggest.sites, the help center and this product. */
  const allowed = (origin: string | undefined) => {
    if (!origin) return false;
    const c = kb.config();
    return origin === new URL(publicUrl).origin || origin === new URL(kb.helpUrl()).origin || !!c?.suggest.sites.includes(origin);
  };
  const cors = (req: IncomingMessage): Record<string, string> =>
    allowed(req.headers.origin) ? { "access-control-allow-origin": req.headers.origin!, vary: "Origin" } : { vary: "Origin" };

  const hits = new Map<string, { minute: number; n: number }>();
  function limited(req: IncomingMessage): boolean {
    const key = req.socket.remoteAddress ?? "";
    const minute = Math.floor(Date.now() / 60_000);
    const h = hits.get(key);
    if (!h || h.minute !== minute) {
      if (hits.size > 10_000) hits.clear();
      hits.set(key, { minute, n: 1 });
      return false;
    }
    return ++h.n > SUGGEST_RATE;
  }

  const shown = (f: Found, lang: string, place: string, sid: string | null, reader: string | null) => {
    const page = `/${lang}/articles/${f.slug}?${new URLSearchParams({ from: place, ...(sid && { s: sid }) })}`;
    // A plan-only article opens through a reader link, so the customer's help center tab may read it.
    const url = reader && f.plans.length ? `${kb.helpUrl()}/reader?${new URLSearchParams({ token: reader, to: page })}` : `${kb.helpUrl()}${page}`;
    return { id: f.id, slug: f.slug, lang: f.lang, title: f.title, excerpt: f.excerpt, topic: f.topic, helpful: f.helpful, url };
  };

  /** Articles for what someone types in a ticket form or chat window. Pages of other origins get no answer to read. */
  function suggest(req: IncomingMessage, res: ServerResponse, url: URL) {
    const headers = { ...cors(req), "cache-control": "no-store" };
    try {
      if (limited(req)) throw new KbError(429, "rate-limited", "Too many suggestions asked from this address; wait a minute.", 60);
      const text = (url.searchParams.get("q") ?? "").slice(0, 200);
      const place = url.searchParams.get("place") ?? "helpdesk-form";
      const limit = Math.min(5, Math.max(1, Number(url.searchParams.get("limit") ?? 3) || 3));
      const readerToken = url.searchParams.get("reader");
      const reader = kb.readReader(readerToken);
      const r = kb.suggest({
        text,
        lang: url.searchParams.get("lang") ?? "",
        place,
        sid: url.searchParams.get("sid") ?? undefined,
        plans: reader?.plans ?? [],
        limit,
        // Only searches from the sites in the file, or from servers (with no Origin), are kept for the reports.
        record: !req.headers.origin || allowed(req.headers.origin),
      });
      json(
        res,
        200,
        { lang: r.lang, search: r.search, articles: r.articles.map((f) => shown(f, r.lang, place, r.search, reader ? readerToken : null)) },
        headers,
      );
    } catch (err) {
      if (!(err instanceof KbError)) throw err;
      problem(res, err.status, err.code, err.message, { ...headers, ...(err.retryAfter ? { "retry-after": String(err.retryAfter) } : {}) });
    }
  }

  async function suggestEvent(req: IncomingMessage, res: ServerResponse) {
    const headers = cors(req);
    try {
      if (req.headers.origin && !allowed(req.headers.origin)) throw new KbError(403, "forbidden-origin", "This origin is not in suggest.sites.");
      const b = (await readJson(req, 4096)) as { sid?: unknown; type?: unknown };
      json(res, 202, kb.suggestEvent(b.sid, b.type), headers);
    } catch (err) {
      if (!(err instanceof KbError)) throw err;
      problem(res, err.status, err.code, err.message, headers);
      if (!req.complete) req.resume();
    }
  }

  /** The suggest script with the knowledge base's settings, for one script tag on the sites' pages. */
  function script(res: ServerResponse) {
    const headers = { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" };
    const c = kb.config();
    if (!suggestScript || !c) return send(res, 503, "/* OpenAsy Knowledge Base: the suggest script is not built. */\n", "text/javascript", headers);
    const w = Object.fromEntries(
      [...new Set(["en", ...c.site.languages.map((l) => l.slice(0, 2))])].map((l) => {
        const t = words(l);
        return [l, { heading: t("suggestHeading"), helpful: t("suggestHelpful", { n: "{n}" }) }];
      }),
    );
    const config = {
      endpoint: `${publicUrl}/api/v1/suggest`,
      events: `${publicUrl}/api/v1/suggest/events`,
      languages: c.site.languages,
      defaultLanguage: c.site.defaultLanguage,
      words: w,
    };
    send(res, 200, `/* OpenAsy Knowledge Base */\n(function(){\n${suggestScript}\nOAKB.start(${JSON.stringify(config)});\n})();\n`, "text/javascript", headers);
  }

  function authorize(req: IncomingMessage, access: Access): Actor {
    if (access === "none") return { id: "anonymous", name: "Anonymous" };
    if (tokenMatches(req.headers.authorization, adminToken)) return { id: "admin-token", name: "Admin token" };
    const p = auth.authorize(req, access);
    return p.kind === "session" ? { id: p.user.id, name: p.user.name } : { id: `token:${p.tokenId}`, name: p.name };
  }

  /** The host the help center has its own address at, when it is not this product's. */
  function helpHost(): string | null {
    const address = kb.config()?.site.address;
    if (!address) return null;
    const a = new URL(address);
    return a.origin === new URL(publicUrl).origin ? null : a.host;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz") return (json(res, 200, { status: "ok" }), "/healthz");

    if (path === "/readyz") {
      try {
        db.prepare("SELECT 1").get();
        if (!kb.config()) throw new Error("no settings");
        json(res, 200, { status: "ready" });
      } catch {
        json(res, 503, { status: "not ready" });
      }
      return "/readyz";
    }

    if (path === "/s/suggest.js" && (req.method === "GET" || req.method === "HEAD")) return (script(res), "/s/suggest.js");
    if (path === "/api/v1/suggest" && req.method === "GET") return (suggest(req, res, url), "/api/v1/suggest");
    if (path === "/api/v1/suggest/events" && req.method === "POST") return (await suggestEvent(req, res), "/api/v1/suggest/events");
    if ((path === "/api/v1/suggest" || path === "/api/v1/suggest/events") && req.method === "OPTIONS") {
      res
        .writeHead(204, {
          ...cors(req),
          "access-control-allow-methods": "GET, POST",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "600",
        })
        .end();
      return path;
    }

    // The help center: at its own address when the file gives one, and at /help always.
    const secure = kb.helpUrl().startsWith("https://");
    const host = helpHost();
    if (host && req.headers.host === host) return help.handle(req, res, "", path, url, secure);
    if (path === "/help" || path.startsWith("/help/")) return help.handle(req, res, "/help", path.slice("/help".length), url, secure);

    if (path === "/metrics") {
      // Not even the web UI's fallback answers here when metrics have their own port.
      if (serveMetrics) send(res, 200, metricsText(kb, version), "text/plain; version=0.0.4");
      else problem(res, 404, "not-found");
      return "/metrics";
    }

    if (path === "/api/openapi.json" && spec) return (send(res, 200, spec), "/api/openapi.json");

    if (docsDir && (path === "/api/docs" || path.startsWith("/api/docs/"))) {
      if (path === "/api/docs") {
        res.writeHead(301, { ...SECURITY_HEADERS, location: "/api/docs/" }).end();
        return "/api/docs";
      }
      const relative = path.slice("/api/docs/".length) || "index.html";
      if (!(await serveFile(res, docsDir, relative))) problem(res, 404, "not-found");
      return "/api/docs";
    }

    if (await auth.handle(req, res)) return auth.routeName(req) ?? "/api/v1/auth/*";

    for (const r of compiled) {
      const m = path.match(r.re);
      if (!m || r.method !== req.method) continue;
      try {
        const who = authorize(req, r.auth);
        const params = m.slice(1).map(decodeURIComponent);
        const result = await r.handle({ req, res, url, params, who, body: () => readJson(req, r.limit ?? 1024 * 1024) });
        if (!res.headersSent && result !== undefined) json(res, 200, result);
      } catch (err) {
        if (err instanceof AuthError) {
          sendProblem(res, err);
          if (!req.complete) req.resume();
          return r.path;
        }
        if (!(err instanceof KbError)) throw err;
        problem(res, err.status, err.code, err.message, err.retryAfter ? { "retry-after": String(err.retryAfter) } : {});
        // Unread request bodies would otherwise hold the connection.
        if (!req.complete) req.resume();
      }
      return r.path;
    }

    if (path.startsWith("/api/")) return (problem(res, 404, "not-found"), "/api/*");

    if (webDir && (req.method === "GET" || req.method === "HEAD")) {
      // Unknown paths fall back to the single-page app.
      if (!(await serveFile(res, webDir, path === "/" ? "index.html" : path))) send(res, 200, await readFile(join(webDir, "index.html")), TYPES[".html"]);
      return "/web";
    }

    problem(res, 404, "not-found");
    return "unmatched";
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    let routeName = "error";
    try {
      routeName = await route(req, res);
    } catch (err) {
      log("error", "request failed", { error: String(err), path: req.url });
      if (!res.headersSent) problem(res, 500, "internal-error");
    }
    countRequest(req.method ?? "GET", routeName, res.statusCode);
    // Readers' searches and suggestions arrive with every key; logging each would put what customers type in the logs.
    if (!["/healthz", "/metrics", "/api/v1/suggest", "/api/v1/suggest/events", "/s/suggest.js"].includes(routeName) && !routeName.startsWith("help")) {
      log("info", "request", { method: req.method, path: (req.url ?? "/").split("?")[0], status: res.statusCode, ms: Math.round(performance.now() - started) });
    }
  };
}
