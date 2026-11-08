// The knowledge base: articles and their languages, from draft through review to the help center; the search that the
// help center, the ticket form and the chat window share; and what readers did: views, "did this help" answers,
// searches that found nothing, and forms and chats closed after an article.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { PLACES, slugify, type Config, type ConfigFileState, type Place } from "./config.ts";
import { cleanQuery, excerpt, fold, importFile, plainText, render, sanitize, type Format } from "./content.ts";

export type ProblemCode =
  "invalid-token" | "invalid-json" | "invalid-body" | "forbidden-origin" | "not-found" | "conflict" | "rate-limited" | "payload-too-large" | "internal-error";

export class KbError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  readonly retryAfter?: number;
  constructor(status: number, code: ProblemCode, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** Who changes something: a signed-in person, an API token or the tests' admin token. */
export interface Actor {
  id: string;
  name: string;
}

export type State = "draft" | "review" | "published";
export type Range = 7 | 30 | 90;
/** Where a search was typed: the help center, one of the suggest places, or the team's own preview (not kept). */
export type SearchPlace = Place | "help-center";

const DAY = 86_400_000;
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const SID = /^[A-Za-z0-9_-]{8,64}$/;

export function parseRange(v: string | null): Range {
  if (v === null || v === "") return 30;
  const n = Number(v);
  if (n !== 7 && n !== 30 && n !== 90) throw new KbError(422, "invalid-body", "days is 7, 30 or 90.");
  return n;
}

/** The last `n` days in UTC, today last. */
export function lastDays(n: number, now: number): string[] {
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  return Array.from({ length: n }, (_, i) => new Date(today - (n - 1 - i) * DAY).toISOString().slice(0, 10));
}

interface ArticleRow {
  id: string;
  slug: string;
  topic: string | null;
  plans: string;
  state: State;
  owner_id: string | null;
  owner_name: string;
  submitted_id: string | null;
  submitted_name: string | null;
  submitted_at: string | null;
  reviewed_id: string | null;
  reviewed_name: string | null;
  note: string | null;
  gap: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

interface TranslationRow {
  article_id: string;
  lang: string;
  title: string;
  format: Format;
  source: string;
  html: string;
  pub_title: string | null;
  pub_html: string | null;
  updated_at: string;
}

export interface Person {
  id: string | null;
  name: string;
}

export interface ArticleSummary {
  id: string;
  slug: string;
  topic: string | null;
  plans: string[];
  state: State;
  /** Readers see it: it was published and not taken down since. */
  live: boolean;
  owner: Person;
  /** Languages being written, and the ones readers see. */
  languages: string[];
  liveLanguages: string[];
  /** In the default language, or the first one written. */
  title: string;
  titles: Record<string, string>;
  /** Views in the period asked for. */
  views: number;
  /** Share of "did this help" answers that were yes, 0 to 100; null without answers. */
  helpful: number | null;
  votes: number;
  /** Ticket forms and chats closed after reading it, in the period. */
  answered: number;
  updatedAt: string;
  publishedAt: string | null;
  submittedBy: Person | null;
  submittedAt: string | null;
  note: string | null;
  /** Where readers find it, while it is live. */
  url: string | null;
}

export interface Translation {
  lang: string;
  title: string;
  format: Format;
  source: string;
  html: string;
  /** What readers see in this language; null until it is published. */
  published: { title: string; html: string } | null;
  updatedAt: string;
}

export interface ArticleDetail extends ArticleSummary {
  translations: Translation[];
  reviewedBy: Person | null;
  gap: { query: string; lang: string } | null;
}

export interface TranslationInput {
  title: string;
  body: string;
  format: Format;
}

export interface ArticleInput {
  lang: string;
  title: string;
  body?: string;
  format?: Format;
  topic?: string | null;
  plans?: string[];
  owner?: string;
  slug?: string;
  gap?: { query: string; lang: string };
}

export interface ArticlePatch {
  topic?: string | null;
  plans?: string[];
  owner?: string;
  slug?: string;
  /** A language's words; null removes the language. */
  translations?: Record<string, TranslationInput | null>;
}

/** An article as the help center and the suggestions show it. */
export interface Found {
  id: string;
  slug: string;
  /** The language shown: the reader's, or the default one when it has none. */
  lang: string;
  title: string;
  excerpt: string;
  topic: string | null;
  plans: string[];
  helpful: number | null;
}

export interface KbOptions {
  /** Where the product is opened; the help center is at <publicUrl>/help unless the file gives it an address. */
  publicUrl: string;
  env?: Record<string, string | undefined>;
  clock?: () => number;
  fileState?: () => ConfigFileState | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const b64 = (s: string) => Buffer.from(s).toString("base64url");

export function createKnowledgeBase(db: DatabaseSync, opts: KbOptions) {
  const env = opts.env ?? process.env;
  const clock = opts.clock ?? Date.now;
  let config: Config | null = null;
  let configText = "";
  const now = () => new Date(clock()).toISOString();
  const cfg = (): Config => {
    if (!config) throw new KbError(503, "internal-error", "The settings file is not applied yet.");
    return config;
  };

  const q = <T>(sql: string, ...args: SQLInputValue[]) => db.prepare(sql).all(...args) as T[];
  const one = <T>(sql: string, ...args: SQLInputValue[]) => db.prepare(sql).get(...args) as T | undefined;
  const run = (sql: string, ...args: SQLInputValue[]) => db.prepare(sql).run(...args);
  const tx = <T>(fn: () => T): T => {
    db.exec("BEGIN");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };

  /** Where readers open the help center, without a trailing slash. */
  const helpUrl = () => config?.site.address ?? `${opts.publicUrl}/help`;
  const since = (days: number, back = 0) => lastDays(days * (back + 1), clock())[0]!;
  const sinceAt = (days: number, back = 0) => `${since(days, back)}T00:00:00.000Z`;

  // ------------------------------------------------------------------ settings

  function setConfig(next: Config, text: string): string[] {
    const warnings: string[] = [];
    const topics = new Set(next.topics.map((t) => t.slug));
    const plans = new Set(next.plans.map((p) => p.id));
    for (const r of q<{ topic: string; n: number }>("SELECT topic, COUNT(*) AS n FROM articles WHERE topic IS NOT NULL GROUP BY topic"))
      if (!topics.has(r.topic)) warnings.push(`${r.n} article(s) have the topic ${r.topic}, which is not in topics; they are listed under Other articles.`);
    const used = new Set(q<{ plans: string }>("SELECT plans FROM articles WHERE plans != '[]'").flatMap((r) => JSON.parse(r.plans) as string[]));
    for (const p of used) if (!plans.has(p)) warnings.push(`Articles are for the plan ${p}, which is not in plans; only reader links that name it open them.`);
    if (next.plans.length && !readerKeyOf(next))
      warnings.push(`${next.readers.key} is not set to a key of 32 characters or more, so no reader link opens a plan-only article.`);
    const langs = new Set(next.site.languages);
    for (const r of q<{ lang: string; n: number }>("SELECT lang, COUNT(*) AS n FROM translations GROUP BY lang"))
      if (!langs.has(r.lang)) warnings.push(`${r.n} article(s) are written in ${r.lang}, which is not in site.languages; readers are shown another language.`);
    config = next;
    configText = text;
    return warnings;
  }

  const readerKeyOf = (c: Config) => {
    const key = env[c.readers.key];
    return key && key.length >= 32 ? key : null;
  };

  function settings() {
    return { config: config ?? null, yaml: configText, file: opts.fileState?.() ?? null, helpUrl: helpUrl() };
  }

  // ------------------------------------------------------------------ reader links

  /**
   * A reader link's token: the plans its holder is on and when it ends, signed with the key readers.key names. The
   * customer's own app makes one for a signed-in customer (see the README), so the help center needs no accounts.
   */
  function signReader(plans: string[], minutes: number): { token: string; expiresAt: string } {
    const key = config && readerKeyOf(config);
    if (!key) throw new KbError(409, "conflict", `${config?.readers.key ?? "The reader key"} is not set to a key of 32 characters or more.`);
    if (!Array.isArray(plans) || plans.length < 1 || plans.length > 50 || plans.some((p) => typeof p !== "string" || !/^[a-z0-9-]{1,32}$/.test(p)))
      throw new KbError(422, "invalid-body", "plans is a list of 1 to 50 plan ids.");
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 43_200) throw new KbError(422, "invalid-body", "minutes is 1 to 43200 (30 days).");
    const exp = Math.floor(clock() / 1000) + minutes * 60;
    const body = `v1.${b64(JSON.stringify({ p: plans, e: exp }))}`;
    return { token: `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`, expiresAt: new Date(exp * 1000).toISOString() };
  }

  /** The plans a reader token names and when it ends, or null when it is not signed with the key or has ended. */
  function readReader(token: string | undefined | null): { plans: string[]; exp: number } | null {
    const key = config && readerKeyOf(config);
    if (!key || !token || token.length > 2048) return null;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") return null;
    const want = createHmac("sha256", key).update(`v1.${parts[1]}`).digest();
    const got = Buffer.from(parts[2]!, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    try {
      const body = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { p?: unknown; e?: unknown };
      if (!Array.isArray(body.p) || typeof body.e !== "number" || body.e * 1000 <= clock()) return null;
      return { plans: body.p.filter((p): p is string => typeof p === "string"), exp: body.e };
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ articles

  const plansOf = (r: ArticleRow) => JSON.parse(r.plans) as string[];
  const translationsOf = (id: string) => q<TranslationRow>("SELECT * FROM translations WHERE article_id = ? ORDER BY lang", id);
  const articleRow = (id: string) => {
    const r = one<ArticleRow>("SELECT * FROM articles WHERE id = ?", id);
    if (!r) throw new KbError(404, "not-found", "No article with that id.");
    return r;
  };
  const defaultLang = () => config?.site.defaultLanguage ?? "en";
  const pick = <T extends { lang: string }>(list: T[], lang?: string) =>
    list.find((t) => t.lang === lang) ?? list.find((t) => t.lang === defaultLang()) ?? list[0];

  function votesOf(ids?: string[]) {
    const rows = q<{ article_id: string; yes: number; n: number }>("SELECT article_id, SUM(helpful) AS yes, COUNT(*) AS n FROM votes GROUP BY article_id");
    const m = new Map(rows.map((r) => [r.article_id, r]));
    return (id: string) => {
      const v = ids && !ids.includes(id) ? undefined : m.get(id);
      return { votes: v?.n ?? 0, helpful: v && v.n ? Math.round((v.yes / v.n) * 100) : null };
    };
  }

  function summaries(rows: ArticleRow[], days: number): ArticleSummary[] {
    const from = since(days);
    const at = sinceAt(days);
    const trs = q<TranslationRow>("SELECT article_id, lang, title, pub_title FROM translations ORDER BY lang");
    const byArticle = new Map<string, TranslationRow[]>();
    for (const t of trs) byArticle.set(t.article_id, [...(byArticle.get(t.article_id) ?? []), t]);
    const views = new Map(
      q<{ article_id: string; v: number }>("SELECT article_id, SUM(n) AS v FROM views WHERE day >= ? GROUP BY article_id", from).map((r) => [
        r.article_id,
        r.v,
      ]),
    );
    const answered = new Map(
      q<{ opened: string; n: number }>(
        "SELECT opened, COUNT(*) AS n FROM searches WHERE opened IS NOT NULL AND outcome = 'closed' AND place != 'help-center' AND at >= ? GROUP BY opened",
        at,
      ).map((r) => [r.opened, r.n]),
    );
    const votes = votesOf();
    return rows.map((r) => {
      const ts = byArticle.get(r.id) ?? [];
      const live = r.published_at !== null;
      const first = pick(ts);
      const liveLangs = ts.filter((t) => t.pub_title !== null).map((t) => t.lang);
      return {
        id: r.id,
        slug: r.slug,
        topic: r.topic,
        plans: plansOf(r),
        state: r.state,
        live,
        owner: { id: r.owner_id, name: r.owner_name },
        languages: ts.map((t) => t.lang),
        liveLanguages: liveLangs,
        title: first?.title ?? "",
        titles: Object.fromEntries(ts.map((t) => [t.lang, t.title])),
        views: views.get(r.id) ?? 0,
        ...votes(r.id),
        answered: answered.get(r.id) ?? 0,
        updatedAt: r.updated_at,
        publishedAt: r.published_at,
        submittedBy: r.submitted_name ? { id: r.submitted_id, name: r.submitted_name } : null,
        submittedAt: r.submitted_at,
        note: r.note,
        url: live && liveLangs.length ? `${helpUrl()}/${pick(liveLangs.map((lang) => ({ lang })))!.lang}/articles/${r.slug}` : null,
      };
    });
  }

  function list(days: Range = 30): ArticleSummary[] {
    return summaries(q<ArticleRow>("SELECT * FROM articles ORDER BY updated_at DESC, id"), days);
  }

  function get(id: string, days: Range = 30): ArticleDetail {
    const r = articleRow(id);
    const [s] = summaries([r], days);
    return {
      ...s!,
      translations: translationsOf(id).map((t) => ({
        lang: t.lang,
        title: t.title,
        format: t.format,
        source: t.source,
        html: t.html,
        published: t.pub_title !== null && t.pub_html !== null ? { title: t.pub_title, html: t.pub_html } : null,
        updatedAt: t.updated_at,
      })),
      reviewedBy: r.reviewed_name ? { id: r.reviewed_id, name: r.reviewed_name } : null,
      gap: r.gap ? (JSON.parse(r.gap) as { query: string; lang: string }) : null,
    };
  }

  // Checks of what is written. Each throws 422 naming the field.
  const bad = (msg: string) => new KbError(422, "invalid-body", msg);
  function checkLang(lang: unknown, at = "lang"): string {
    if (typeof lang !== "string" || !cfg().site.languages.includes(lang))
      throw bad(`${at} is one of the help center's languages: ${cfg().site.languages.join(", ")}.`);
    return lang;
  }
  function checkTopic(topic: unknown): string | null {
    if (topic === null || topic === undefined || topic === "") return null;
    if (typeof topic !== "string" || !cfg().topics.some((t) => t.slug === topic))
      throw bad("topic is the slug of one of the topics in the settings file, or null.");
    return topic;
  }
  function checkPlans(plans: unknown): string[] {
    if (plans === undefined || plans === null) return [];
    if (!Array.isArray(plans) || plans.some((p) => typeof p !== "string" || !cfg().plans.some((x) => x.id === p)))
      throw bad("plans is a list of plan ids from the settings file; [] is everyone.");
    return [...new Set(plans as string[])];
  }
  function checkWords(t: unknown, at: string): TranslationInput {
    if (!isObj(t)) throw bad(`${at} is { title, body, format }.`);
    if (typeof t.title !== "string" || !t.title.trim() || t.title.length > 200) throw bad(`${at}.title is 1 to 200 characters.`);
    const body = t.body ?? "";
    if (typeof body !== "string" || body.length > 200_000) throw bad(`${at}.body is up to 200000 characters.`);
    const format = t.format ?? "markdown";
    if (format !== "markdown" && format !== "html") throw bad(`${at}.format is markdown or html.`);
    return { title: t.title.trim(), body, format };
  }
  function owner(id: unknown, actor: Actor): Person {
    if (id === undefined || id === null || id === actor.id) return { id: actor.id, name: actor.name };
    if (typeof id !== "string") throw bad("owner is the id of a member.");
    const m = team().find((p) => p.id === id);
    if (!m) throw bad("owner is the id of a member of this Knowledge Base.");
    return { id: m.id, name: m.name };
  }
  function uniqueSlug(base: string, except?: string) {
    const root = (slugify(base) || "article").slice(0, 72);
    for (let n = 1; ; n++) {
      const slug = n === 1 ? root : `${root}-${n}`;
      const taken = one<{ id: string }>("SELECT id FROM articles WHERE slug = ?", slug);
      if (!taken || taken.id === except) return slug;
    }
  }
  function checkSlug(slug: unknown, except?: string): string {
    if (typeof slug !== "string" || !SLUG.test(slug)) throw bad("slug is up to 80 lowercase letters, digits and -.");
    const taken = one<{ id: string }>("SELECT id FROM articles WHERE slug = ?", slug);
    if (taken && taken.id !== except) throw new KbError(409, "conflict", `Another article has the address ${slug}.`);
    return slug;
  }

  function writeTranslation(id: string, lang: string, t: TranslationInput) {
    const html = render(t.body, t.format);
    run(
      `INSERT INTO translations (article_id, lang, title, format, source, html, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (article_id, lang) DO UPDATE SET title = excluded.title, format = excluded.format, source = excluded.source, html = excluded.html, updated_at = excluded.updated_at`,
      id,
      lang,
      t.title,
      t.format,
      t.body,
      html,
      now(),
    );
  }

  function create(actor: Actor, input: unknown): ArticleDetail {
    if (!isObj(input)) throw bad("The body is { lang, title, body, format, topic, plans, owner }.");
    const lang = checkLang(input.lang ?? defaultLang());
    const words = checkWords({ title: input.title, body: input.body, format: input.format }, "article");
    const topic = checkTopic(input.topic);
    const plans = checkPlans(input.plans);
    const who = owner(input.owner, actor);
    let gap: { query: string; lang: string } | null = null;
    if (input.gap !== undefined) {
      if (!isObj(input.gap) || typeof input.gap.query !== "string" || typeof input.gap.lang !== "string") throw bad("gap is { query, lang }.");
      gap = { query: input.gap.query.slice(0, 100), lang: input.gap.lang.slice(0, 16) };
    }
    const id = randomUUID();
    return tx(() => {
      const slug = input.slug === undefined ? uniqueSlug(words.title) : checkSlug(input.slug);
      run(
        `INSERT INTO articles (id, slug, topic, plans, state, owner_id, owner_name, gap, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
        id,
        slug,
        topic,
        JSON.stringify(plans),
        who.id,
        who.name,
        gap && JSON.stringify(gap),
        now(),
        now(),
      );
      writeTranslation(id, lang, words);
      if (gap) run("INSERT OR REPLACE INTO gap_links (query, lang, article_id, dismissed_at) VALUES (?, ?, ?, NULL)", gap.query, gap.lang, id);
      return get(id);
    });
  }

  function update(actor: Actor, id: string, patch: unknown): ArticleDetail {
    if (!isObj(patch)) throw bad("The body is { topic, plans, owner, slug, translations }.");
    const r = articleRow(id);
    return tx(() => {
      const sets: string[] = [];
      const args: SQLInputValue[] = [];
      if ("topic" in patch) (sets.push("topic = ?"), args.push(checkTopic(patch.topic)));
      if ("plans" in patch) (sets.push("plans = ?"), args.push(JSON.stringify(checkPlans(patch.plans))));
      if ("owner" in patch) {
        const o = owner(patch.owner, actor);
        sets.push("owner_id = ?", "owner_name = ?");
        args.push(o.id, o.name);
      }
      if ("slug" in patch) (sets.push("slug = ?"), args.push(checkSlug(patch.slug, id)));
      let words = false;
      if (patch.translations !== undefined) {
        if (!isObj(patch.translations)) throw bad("translations is a map of language to { title, body, format }, or null to remove one.");
        const existing = translationsOf(id).map((t) => t.lang);
        for (const [lang, t] of Object.entries(patch.translations)) {
          if (t === null) {
            if (!existing.includes(lang)) continue;
            if (existing.filter((l) => l !== lang).length === 0) throw bad("An article keeps at least one language.");
            run("DELETE FROM translations WHERE article_id = ? AND lang = ?", id, lang);
            existing.splice(existing.indexOf(lang), 1);
            words = true;
            continue;
          }
          checkLang(lang, `translations.${lang}`);
          const w = checkWords(t, `translations.${lang}`);
          const old = one<TranslationRow>("SELECT * FROM translations WHERE article_id = ? AND lang = ?", id, lang);
          if (old && old.title === w.title && old.source === w.body && old.format === w.format) continue;
          writeTranslation(id, lang, w);
          if (!existing.includes(lang)) existing.push(lang);
          words = true;
        }
      }
      // New words go back to draft: they are reviewed before readers see them, and the published ones stay live.
      if (words && r.state !== "draft") sets.push("state = 'draft'", "note = NULL", "submitted_id = NULL", "submitted_name = NULL", "submitted_at = NULL");
      if (sets.length) {
        sets.push("updated_at = ?");
        args.push(now());
        run(`UPDATE articles SET ${sets.join(", ")} WHERE id = ?`, ...args, id);
      }
      if (words) index(id);
      return get(id);
    });
  }

  /** Puts the article's published words in the search, or takes them out. */
  function index(id: string) {
    run("DELETE FROM search_index WHERE article_id = ?", id);
    const r = one<ArticleRow>("SELECT * FROM articles WHERE id = ?", id);
    if (!r || r.published_at === null) return;
    for (const t of translationsOf(id)) {
      if (t.pub_title === null || t.pub_html === null) continue;
      run("INSERT INTO search_index (article_id, lang, title, body) VALUES (?, ?, ?, ?)", id, t.lang, fold(t.pub_title), fold(plainText(t.pub_html)));
    }
  }

  function publish(actor: Actor, id: string) {
    run("UPDATE translations SET pub_title = title, pub_html = html WHERE article_id = ?", id);
    run(
      "UPDATE articles SET state = 'published', published_at = ?, reviewed_id = ?, reviewed_name = ?, note = NULL, updated_at = ? WHERE id = ?",
      now(),
      actor.id,
      actor.name,
      now(),
      id,
    );
    index(id);
  }

  /** Asks for review; publishes at once when the file does not require one. */
  function submit(actor: Actor, id: string): ArticleDetail {
    const r = articleRow(id);
    if (r.state !== "draft")
      throw new KbError(409, "conflict", r.state === "review" ? "The article is already waiting for review." : "The article is published as it is.");
    return tx(() => {
      run(
        "UPDATE articles SET state = 'review', submitted_id = ?, submitted_name = ?, submitted_at = ?, note = NULL, updated_at = ? WHERE id = ?",
        actor.id,
        actor.name,
        now(),
        now(),
        id,
      );
      if (!cfg().review.required) publish(actor, id);
      return get(id);
    });
  }

  function approve(actor: Actor, id: string): ArticleDetail {
    const r = articleRow(id);
    if (r.state !== "review") throw new KbError(409, "conflict", "Only an article waiting for review is approved.");
    if (cfg().review.required && r.submitted_id === actor.id)
      throw new KbError(409, "conflict", "A second person approves an article: someone other than the one who sent it for review.");
    return tx(() => (publish(actor, id), get(id)));
  }

  function sendBack(actor: Actor, id: string, note: unknown): ArticleDetail {
    const r = articleRow(id);
    if (r.state !== "review") throw new KbError(409, "conflict", "Only an article waiting for review is sent back.");
    if (note !== undefined && note !== null && (typeof note !== "string" || note.length > 2000)) throw bad("note is up to 2000 characters.");
    const text = typeof note === "string" && note.trim() ? note.trim() : null;
    run(
      "UPDATE articles SET state = 'draft', note = ?, reviewed_id = ?, reviewed_name = ?, updated_at = ? WHERE id = ?",
      text,
      actor.id,
      actor.name,
      now(),
      id,
    );
    return get(id);
  }

  /** Takes the article off the help center; its words stay as a draft. */
  function unpublish(id: string): ArticleDetail {
    const r = articleRow(id);
    if (r.published_at === null) throw new KbError(409, "conflict", "The article is not on the help center.");
    return tx(() => {
      run("UPDATE translations SET pub_title = NULL, pub_html = NULL WHERE article_id = ?", id);
      run("UPDATE articles SET state = 'draft', published_at = NULL, updated_at = ? WHERE id = ?", now(), id);
      index(id);
      return get(id);
    });
  }

  function remove(id: string) {
    articleRow(id);
    tx(() => {
      run("DELETE FROM search_index WHERE article_id = ?", id);
      run("DELETE FROM views WHERE article_id = ?", id);
      run("DELETE FROM articles WHERE id = ?", id);
    });
  }

  /** Markdown or HTML files from another help center, each a draft in the language and topic given. */
  function importFiles(actor: Actor, body: unknown): { created: ArticleSummary[]; skipped: Array<{ name: string; reason: string }> } {
    if (!isObj(body)) throw bad("The body is { format, lang, topic, files: [{ name, content }] }.");
    const format = body.format;
    if (format !== "markdown" && format !== "html") throw bad("format is markdown or html.");
    const lang = checkLang(body.lang ?? defaultLang());
    const topic = checkTopic(body.topic);
    if (!Array.isArray(body.files) || body.files.length < 1 || body.files.length > 200) throw bad("files is a list of 1 to 200 files.");
    const created: string[] = [];
    const skipped: Array<{ name: string; reason: string }> = [];
    for (const [i, f] of body.files.entries()) {
      if (!isObj(f) || typeof f.name !== "string" || typeof f.content !== "string") throw bad(`files[${i}] is { name, content }.`);
      const name = f.name.slice(0, 200);
      if (f.content.length > 200_000) {
        skipped.push({ name, reason: "longer than 200000 characters" });
        continue;
      }
      const doc = importFile(name, f.content, format);
      const docLang = doc.lang && cfg().site.languages.includes(doc.lang) ? doc.lang : lang;
      const docTopic = doc.topic && cfg().topics.some((t) => t.slug === doc.topic) ? doc.topic : topic;
      const docPlans = (doc.plans ?? []).filter((p) => cfg().plans.some((x) => x.id === p));
      const slug = doc.slug && SLUG.test(doc.slug) && !one("SELECT 1 FROM articles WHERE slug = ?", doc.slug) ? doc.slug : undefined;
      const a = create(actor, { lang: docLang, title: doc.title, body: doc.body, format: doc.format, topic: docTopic, plans: docPlans, ...(slug && { slug }) });
      created.push(a.id);
    }
    const rows = created.map((id) => articleRow(id));
    return { created: summaries(rows, 30), skipped };
  }

  /** Members, to choose an article's owner. */
  function team(): Array<{ id: string; name: string; email: string }> {
    try {
      return q<{ id: string; name: string; email: string }>("SELECT id, name, email FROM auth_users WHERE status != 'disabled' ORDER BY name COLLATE NOCASE");
    } catch {
      return [];
    }
  }

  // ------------------------------------------------------------------ the help center

  const visible = (r: ArticleRow, plans: string[]) => r.published_at !== null && (r.plans === "[]" || plansOf(r).some((p) => plans.includes(p)));

  function liveTranslations(id: string) {
    return translationsOf(id).filter((t) => t.pub_title !== null && t.pub_html !== null) as Array<TranslationRow & { pub_title: string; pub_html: string }>;
  }

  function found(r: ArticleRow, lang: string, votes: ReturnType<typeof votesOf>): Found | null {
    const t = pick(liveTranslations(r.id), lang);
    if (!t) return null;
    return {
      id: r.id,
      slug: r.slug,
      lang: t.lang,
      title: t.pub_title,
      excerpt: excerpt(plainText(t.pub_html)),
      topic: r.topic,
      plans: plansOf(r),
      helpful: votes(r.id).helpful,
    };
  }

  /** The topics of the file with the articles a reader may see, in the reader's language where there is one. */
  function topics(lang: string, plans: string[]) {
    const rows = q<ArticleRow>("SELECT * FROM articles WHERE published_at IS NOT NULL ORDER BY slug").filter((r) => visible(r, plans));
    const votes = votesOf();
    const views = new Map(
      q<{ article_id: string; v: number }>("SELECT article_id, SUM(n) AS v FROM views WHERE day >= ? GROUP BY article_id", since(90)).map((r) => [
        r.article_id,
        r.v,
      ]),
    );
    const all = rows
      .map((r) => found(r, lang, votes))
      .filter((f): f is Found => f !== null)
      .sort((a, b) => (views.get(b.id) ?? 0) - (views.get(a.id) ?? 0) || a.title.localeCompare(b.title));
    const known = new Set(cfg().topics.map((t) => t.slug));
    return {
      topics: cfg().topics.map((t) => ({ slug: t.slug, name: t.names[lang] ?? t.name, articles: all.filter((a) => a.topic === t.slug) })),
      other: all.filter((a) => !a.topic || !known.has(a.topic)),
      popular: all.slice(0, 6),
    };
  }

  /** The article a reader opened: in their language, or the default one; "plan" when it is for other customers. */
  function article(slug: string, lang: string, plans: string[]) {
    const r = one<ArticleRow>("SELECT * FROM articles WHERE slug = ?", slug);
    if (!r || r.published_at === null) return null;
    if (!visible(r, plans)) return { kind: "plan" as const };
    const trs = liveTranslations(r.id);
    const t = pick(trs, lang);
    if (!t) return null;
    const votes = votesOf();
    const related = q<ArticleRow>("SELECT * FROM articles WHERE topic IS ? AND id != ? AND published_at IS NOT NULL ORDER BY slug LIMIT 20", r.topic, r.id)
      .filter((x) => visible(x, plans))
      .map((x) => found(x, lang, votes))
      .filter((f): f is Found => f !== null)
      .slice(0, 5);
    return {
      kind: "article" as const,
      id: r.id,
      slug: r.slug,
      topic: r.topic,
      plans: plansOf(r),
      lang: t.lang,
      title: t.pub_title,
      // Sanitized when it was written; again here, so a body stored by an older version is held to today's rules.
      html: sanitize(t.pub_html),
      languages: trs.map((x) => x.lang),
      updatedAt: r.published_at,
      related,
    };
  }

  /** Published articles that match the words, best first, that the reader may see. */
  function search(text: string, lang: string, plans: string[], limit = 20): Found[] {
    const terms = [
      ...new Set(
        fold(text)
          .split(/[^\p{L}\p{N}]+/u)
          .filter(Boolean),
      ),
    ].slice(0, 8);
    if (!terms.length) return [];
    const match = (op: string) => terms.map((t) => `"${t.replace(/"/g, "")}"*`).join(` ${op} `);
    // bm25 cannot be used in a grouped query, so the best line of each article is taken here.
    const find = (op: string) => {
      const rows = q<{ article_id: string }>(
        "SELECT article_id, bm25(search_index, 0, 0, 4.0, 1.0) AS rank FROM search_index WHERE search_index MATCH ? ORDER BY rank LIMIT 1000",
        match(op),
      );
      return [...new Set(rows.map((r) => r.article_id))].map((article_id) => ({ article_id }));
    };
    let hits = find("AND");
    if (!hits.length && terms.length > 1) hits = find("OR");
    const votes = votesOf();
    const out: Found[] = [];
    for (const h of hits) {
      const r = one<ArticleRow>("SELECT * FROM articles WHERE id = ?", h.article_id);
      if (!r || !visible(r, plans)) continue;
      const f = found(r, lang, votes);
      if (f) out.push(f);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Keeps a search with the number of articles it found; its id ties a later view, ticket or closed form to it. */
  function recordSearch(place: SearchPlace, lang: string, text: string, results: number, id: string = randomBytes(12).toString("base64url")): string | null {
    const query = cleanQuery(text);
    if (query.length < 2) return null;
    run(
      `INSERT INTO searches (id, place, lang, query, results, at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET query = excluded.query, results = excluded.results, lang = excluded.lang, at = excluded.at WHERE searches.place = excluded.place`,
      id,
      place,
      lang,
      query,
      results,
      now(),
    );
    return id;
  }

  /**
   * Articles for what someone is typing in a ticket form or chat window. `sid` names that form while it is open: its
   * last words are what is kept, so typing a subject is one search, not one per key.
   */
  function suggest({
    text,
    lang,
    place,
    sid,
    plans,
    limit,
    record,
  }: {
    text: string;
    lang: string;
    place: string;
    sid?: string;
    plans: string[];
    limit: number;
    record: boolean;
  }) {
    const l = cfg().site.languages.includes(lang) ? lang : defaultLang();
    const kept = record && (place === "preview" ? false : cfg().suggest.in.includes(place as Place));
    if (place !== "preview" && !(PLACES as readonly string[]).includes(place)) throw bad(`place is one of ${PLACES.join(", ")}.`);
    if (sid !== undefined && !SID.test(sid)) throw bad("sid is 8 to 64 letters, digits, _ and -.");
    const articles = cleanQuery(text).length >= 2 ? search(text, l, plans, limit) : [];
    const id = kept && sid ? recordSearch(place as Place, l, text, articles.length, sid) : null;
    return { lang: l, search: id, articles };
  }

  /** The ticket was sent, or the form or chat closed, after the suggestions. */
  function suggestEvent(sid: unknown, type: unknown) {
    if (typeof sid !== "string" || !SID.test(sid)) throw bad("sid is 8 to 64 letters, digits, _ and -.");
    if (type !== "ticket" && type !== "closed") throw bad("type is ticket or closed.");
    // A ticket sent after the form was closed once still counts as a ticket.
    const r = run("UPDATE searches SET outcome = ? WHERE id = ? AND place != 'help-center' AND (outcome IS NULL OR outcome = 'closed')", type, sid);
    return { recorded: Number(r.changes) > 0 };
  }

  /** One view of a live article, by where the reader came from; `search` ties it to the search it was found with. */
  function recordView(id: string, lang: string, source: string, searchId?: string) {
    run(
      "INSERT INTO views (article_id, lang, day, source, n) VALUES (?, ?, ?, ?, 1) ON CONFLICT (article_id, lang, day, source) DO UPDATE SET n = n + 1",
      id,
      lang,
      now().slice(0, 10),
      source.slice(0, 64),
    );
    if (searchId && SID.test(searchId)) run("UPDATE searches SET opened = ? WHERE id = ? AND opened IS NULL", id, searchId);
  }

  function vote(id: string, lang: string, helpful: boolean) {
    run("INSERT INTO votes (article_id, lang, helpful, at) VALUES (?, ?, ?, ?)", id, lang, helpful ? 1 : 0, now());
  }

  // ------------------------------------------------------------------ reports

  function report(days: Range) {
    const from = since(days);
    const before = since(days, 1);
    const at = sinceAt(days);
    const sum = (sql: string, ...a: SQLInputValue[]) => (one<{ n: number | null }>(sql, ...a)?.n ?? 0) as number;
    const views = sum("SELECT SUM(n) AS n FROM views WHERE day >= ?", from);
    const viewsBefore = sum("SELECT SUM(n) AS n FROM views WHERE day >= ? AND day < ?", before, from);
    const searches = sum("SELECT COUNT(*) AS n FROM searches WHERE at >= ?", at);
    const noResult = sum("SELECT COUNT(*) AS n FROM searches WHERE at >= ? AND results = 0", at);
    const answered = sum("SELECT COUNT(*) AS n FROM searches WHERE at >= ? AND place != 'help-center' AND opened IS NOT NULL AND outcome = 'closed'", at);
    const votes = one<{ n: number; yes: number | null }>("SELECT COUNT(*) AS n, SUM(helpful) AS yes FROM votes WHERE at >= ?", at)!;
    const states = q<{ state: State; live: number; n: number }>(
      "SELECT state, published_at IS NOT NULL AS live, COUNT(*) AS n FROM articles GROUP BY state, live",
    );
    const dayList = lastDays(days, clock());
    const perDay = q<{ day: string; lang: string; n: number }>("SELECT day, lang, SUM(n) AS n FROM views WHERE day >= ? GROUP BY day, lang", from);
    const all = list(days);
    const cutoff = cfg().helpful;
    return {
      days,
      from,
      languages: cfg().site.languages,
      totals: {
        views,
        viewsBefore,
        searches,
        noResult,
        answered,
        votes: votes.n,
        helpful: votes.n ? Math.round(((votes.yes ?? 0) / votes.n) * 100) : null,
        articles: all.length,
        live: states.filter((s) => s.live).reduce((a, s) => a + s.n, 0),
        review: states.filter((s) => s.state === "review").reduce((a, s) => a + s.n, 0),
      },
      series: dayList.map((day) => ({
        day,
        views: Object.fromEntries(cfg().site.languages.map((l) => [l, perDay.find((p) => p.day === day && p.lang === l)?.n ?? 0])),
      })),
      sources: q<{ source: string; views: number }>(
        "SELECT source, SUM(n) AS views FROM views WHERE day >= ? GROUP BY source ORDER BY views DESC LIMIT 10",
        from,
      ),
      mostRead: all
        .filter((a) => a.views > 0)
        .sort((a, b) => b.views - a.views)
        .slice(0, 5)
        .map((a) => ({ id: a.id, title: a.title, topic: a.topic, views: a.views, answered: a.answered })),
      lowHelpful: all
        .filter((a) => a.live && a.helpful !== null && a.votes >= cutoff.minAnswers && a.helpful < cutoff.listBelow)
        .sort((a, b) => a.helpful! - b.helpful!)
        .map((a) => ({ id: a.id, title: a.title, owner: a.owner, updatedAt: a.updatedAt, helpful: a.helpful!, votes: a.votes })),
    };
  }

  function gaps(days: Range) {
    const at = sinceAt(days);
    const atBefore = sinceAt(days, 1);
    const share = (from: string, to?: string) => {
      const r = one<{ n: number; none: number | null }>(
        `SELECT COUNT(*) AS n, SUM(results = 0) AS none FROM searches WHERE at >= ?${to ? " AND at < ?" : ""}`,
        ...(to ? [from, to] : [from]),
      )!;
      return { searches: r.n, none: r.none ?? 0, share: r.n ? (r.none ?? 0) / r.n : 0 };
    };
    const rows = q<{ query: string; lang: string; n: number; tickets: number; places: string; last: string }>(
      `SELECT s.query, s.lang, COUNT(*) AS n, COALESCE(SUM(s.outcome = 'ticket'), 0) AS tickets, GROUP_CONCAT(DISTINCT s.place) AS places, MAX(s.at) AS last
       FROM searches s LEFT JOIN gap_links g ON g.query = s.query AND g.lang = s.lang
       WHERE s.results = 0 AND s.at >= ? AND g.query IS NULL
       GROUP BY s.query, s.lang ORDER BY n DESC, last DESC LIMIT 500`,
      at,
    );
    const nowShare = share(at);
    const beforeShare = share(atBefore, at);
    return {
      days,
      from: since(days),
      totals: {
        searches: nowShare.searches,
        noResult: nowShare.none,
        share: nowShare.share,
        shareBefore: beforeShare.searches ? beforeShare.share : null,
        tickets: rows.reduce((a, r) => a + r.tickets, 0),
        different: rows.length,
      },
      gaps: rows.map((r) => ({ query: r.query, lang: r.lang, count: r.n, tickets: r.tickets, places: r.places.split(",") as SearchPlace[], last: r.last })),
    };
  }

  /** Sets a search with no answer aside, so it is no longer listed. */
  function dismissGap(body: unknown) {
    if (!isObj(body) || typeof body.query !== "string" || typeof body.lang !== "string" || !body.query || body.query.length > 100)
      throw bad("The body is { query, lang }.");
    run("INSERT OR REPLACE INTO gap_links (query, lang, article_id, dismissed_at) VALUES (?, ?, NULL, ?)", body.query, body.lang.slice(0, 16), now());
  }

  function suggestions(days: Range) {
    const at = sinceAt(days);
    const atBefore = sinceAt(days, 1);
    const rows = q<{ place: string; shown: number; opened: number; answered: number; ticket: number }>(
      `SELECT place, SUM(results > 0) AS shown, SUM(opened IS NOT NULL) AS opened,
         SUM(opened IS NOT NULL AND outcome = 'closed') AS answered, SUM(opened IS NOT NULL AND outcome = 'ticket') AS ticket
       FROM searches WHERE at >= ? AND place != 'help-center' GROUP BY place`,
      at,
    );
    const answeredBefore =
      one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM searches WHERE at >= ? AND at < ? AND place != 'help-center' AND opened IS NOT NULL AND outcome = 'closed'",
        atBefore,
        at,
      )?.n ?? 0;
    const total = (k: "shown" | "opened" | "answered" | "ticket") => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
    return {
      days,
      from: since(days),
      places: cfg().suggest.in,
      totals: { shown: total("shown"), opened: total("opened"), answered: total("answered"), ticket: total("ticket"), answeredBefore },
      byPlace: rows.map((r) => ({ place: r.place as Place, shown: r.shown ?? 0, opened: r.opened ?? 0, answered: r.answered ?? 0 })),
    };
  }

  function summary() {
    const counts = q<{ state: State; n: number }>("SELECT state, COUNT(*) AS n FROM articles GROUP BY state");
    const n = (s: State) => counts.find((c) => c.state === s)?.n ?? 0;
    const g = config ? gaps(30).totals.different : 0;
    return {
      file: opts.fileState?.() ?? null,
      helpUrl: helpUrl(),
      siteName: config?.site.name ?? "Help center",
      articles: { total: n("draft") + n("review") + n("published"), published: n("published"), review: n("review"), draft: n("draft") },
      gaps: g,
    };
  }

  function gauges() {
    const counts = q<{ state: string; n: number }>("SELECT state, COUNT(*) AS n FROM articles GROUP BY state");
    return { articles: Object.fromEntries(counts.map((c) => [c.state, c.n])) as Record<string, number> };
  }

  /** Searches are kept a year and daily views two; answers stay with their article. */
  function purge() {
    run("DELETE FROM searches WHERE at < ?", new Date(clock() - 365 * DAY).toISOString());
    run("DELETE FROM views WHERE day < ?", new Date(clock() - 730 * DAY).toISOString().slice(0, 10));
  }

  return {
    /** The clock everything is dated by. */
    now: () => clock(),
    setConfig,
    config: () => config,
    settings,
    helpUrl,
    signReader,
    readReader,
    list,
    get,
    create,
    update,
    submit,
    approve,
    sendBack,
    unpublish,
    remove,
    importFiles,
    preview: (body: unknown) => {
      if (!isObj(body) || typeof body.body !== "string" || body.body.length > 200_000 || (body.format !== "markdown" && body.format !== "html"))
        throw bad("The body is { body, format }, up to 200000 characters.");
      return { html: render(body.body, body.format) };
    },
    team,
    topics,
    article,
    search,
    recordSearch,
    suggest,
    suggestEvent,
    recordView,
    vote,
    report,
    gaps,
    dismissGap,
    suggestions,
    summary,
    gauges,
    purge,
  };
}

export type KnowledgeBase = ReturnType<typeof createKnowledgeBase>;
