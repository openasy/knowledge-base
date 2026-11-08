// The help center's settings, from one YAML file (KNOWLEDGE_BASE_CONFIG): its address and languages, the topics, review,
// the plans whose customers see their own articles, and the sites that suggest articles. As with Analytics's sites file,
// the file is the only way in: no screen or API route changes these. It is applied whole or not at all, read again
// within a minute of a change, and a file with a mistake leaves the last good version in place. Articles themselves are
// written in the UI and kept in the database.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { parse } from "yaml";

export interface Topic {
  /** In the help center's addresses: /en/topics/<slug>. */
  slug: string;
  name: string;
  /** The topic's name in other languages, by language code. */
  names: Record<string, string>;
}

export interface Plan {
  /** What reader links name, such as business. */
  id: string;
  name: string;
}

/** Where the suggest script may run: Helpdesk's ticket form, the Live Chat window, beside a ticket in Helpdesk, or in your app. */
export const PLACES = ["helpdesk-form", "live-chat", "helpdesk-agent", "app"] as const;
export type Place = (typeof PLACES)[number];

export interface Config {
  site: {
    name: string;
    /** The help center's own address, such as https://help.example.com; null to serve it at <public url>/help. */
    address: string | null;
    /** The languages articles are written in; the first is not special, defaultLanguage is. */
    languages: string[];
    /** Shown to readers of a language that has no version of an article. */
    defaultLanguage: string;
    /** An Analytics script for the help center's pages, such as https://analytics.example.com/s/help.js; null for none. */
    analytics: string | null;
  };
  topics: Topic[];
  review: {
    /** true: an article is public only once a second person approves it. false: its writer publishes it. */
    required: boolean;
  };
  helpful: {
    /** Articles helpful less often than this share (0 to 100) are listed for their owner. */
    listBelow: number;
    /** ...once they have at least this many answers. */
    minAnswers: number;
  };
  plans: Plan[];
  readers: {
    /** The environment variable holding the key that signs reader links for plan-only articles; never the key itself. */
    key: string;
  };
  suggest: {
    /** The places the suggest script runs in. */
    in: Place[];
    /** The origins whose pages may load the suggest script and call the suggest API, such as https://www.example.com. */
    sites: string[];
  };
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ENV = /^[A-Z][A-Z0-9_]{0,63}$/;
const LANG = /^[a-z]{2,3}(-[A-Z]{2})?$/;
const TOP = ["site", "topics", "review", "helpful", "plans", "readers", "suggest"];
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function keys(v: Record<string, unknown>, at: string, allowed: string[]) {
  const extra = Object.keys(v).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`${at}: unknown ${extra.join(", ")}; it takes ${allowed.join(", ")}.`);
}

function text(v: unknown, at: string, max = 80): string {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error(`${at} is a text of 1 to ${max} characters.`);
  return v.trim();
}

function origin(raw: unknown, at: string): string {
  const url = typeof raw === "string" ? URL.parse(raw.trim()) : null;
  const local = url && /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
  if (!url || (url.protocol !== "https:" && !(url.protocol === "http:" && local)) || (url.pathname !== "/" && url.pathname !== "") || url.search)
    throw new Error(`${at} is an origin with https://, such as https://help.example.com (http:// only for localhost).`);
  return url.origin;
}

/** A topic's slug from its name: "Account and sign-in" is account-and-sign-in. */
export function slugify(name: string): string {
  return (
    name
      .toLocaleLowerCase("en")
      .replace(/ı/g, "i")
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64)
      .replace(/-+$/, "") || "topic"
  );
}

/** Reads the file's text. Throws with the field at fault, so one message says what to fix. */
export function parseConfig(raw: string): Config {
  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (err) {
    throw new Error(`Not valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  if (doc === null || doc === undefined) doc = {};
  if (!isObj(doc)) throw new Error(`The file is a map of ${TOP.join(", ")}.`);
  keys(doc, "The file", TOP);

  const s = doc.site ?? {};
  if (!isObj(s)) throw new Error("site is a map with name, address, languages, default_language and analytics.");
  keys(s, "site", ["name", "address", "languages", "default_language", "analytics"]);
  const name = s.name === undefined ? "Help center" : text(s.name, "site.name");
  const address = s.address === undefined || s.address === null ? null : origin(s.address, "site.address");
  const langs = s.languages ?? ["en"];
  if (!Array.isArray(langs) || langs.length < 1 || langs.length > 20 || langs.some((l) => typeof l !== "string" || !LANG.test(l)))
    throw new Error("site.languages is a list of 1 to 20 language codes, such as [tr, en].");
  const languages = [...new Set(langs as string[])];
  const defaultLanguage = s.default_language === undefined ? languages[0]! : s.default_language;
  if (typeof defaultLanguage !== "string" || !languages.includes(defaultLanguage))
    throw new Error(`site.default_language is one of site.languages: ${languages.join(", ")}.`);
  let analytics: string | null = null;
  if (s.analytics !== undefined && s.analytics !== null) {
    const url = typeof s.analytics === "string" ? URL.parse(s.analytics.trim()) : null;
    const local = url && /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
    if (!url || (url.protocol !== "https:" && !(url.protocol === "http:" && local)) || !url.pathname.endsWith(".js") || url.search || url.hash)
      throw new Error("site.analytics is the address of an Analytics site's script, such as https://analytics.example.com/s/help.js.");
    analytics = url.href;
  }

  const topics: Topic[] = [];
  const rawTopics = doc.topics ?? [];
  if (!Array.isArray(rawTopics) || rawTopics.length > 200) throw new Error("topics is a list of up to 200 topics.");
  rawTopics.forEach((t, i) => {
    const at = `topics[${i}]`;
    let topic: Topic;
    if (typeof t === "string") topic = { slug: slugify(t), name: text(t, at), names: {} };
    else {
      if (!isObj(t)) throw new Error(`${at} is a name, or a map with name, slug and names.`);
      keys(t, at, ["name", "slug", "names"]);
      const tname = text(t.name, `${at}.name`);
      if (t.slug !== undefined && (typeof t.slug !== "string" || !SLUG.test(t.slug)))
        throw new Error(`${at}.slug is up to 64 lowercase letters, digits and -.`);
      const names: Record<string, string> = {};
      if (t.names !== undefined) {
        if (!isObj(t.names)) throw new Error(`${at}.names is a map of language code to name, such as { tr: Bankacılık }.`);
        for (const [l, n] of Object.entries(t.names)) {
          if (!languages.includes(l)) throw new Error(`${at}.names.${l}: ${l} is not one of site.languages.`);
          names[l] = text(n, `${at}.names.${l}`);
        }
      }
      topic = { slug: (t.slug as string | undefined) ?? slugify(tname), name: tname, names };
    }
    if (topics.some((x) => x.slug === topic.slug)) throw new Error(`${at}: the slug ${topic.slug} is in the file twice; give one a slug of its own.`);
    topics.push(topic);
  });

  const r = doc.review ?? {};
  if (!isObj(r)) throw new Error("review is a map with required.");
  keys(r, "review", ["required"]);
  if (r.required !== undefined && typeof r.required !== "boolean") throw new Error("review.required is true or false.");

  const h = doc.helpful ?? {};
  if (!isObj(h)) throw new Error("helpful is a map with list_below and min_answers.");
  keys(h, "helpful", ["list_below", "min_answers"]);
  let listBelow = 60;
  if (h.list_below !== undefined) {
    const m = typeof h.list_below === "number" ? [String(h.list_below), String(h.list_below)] : /^(\d+(?:\.\d+)?)\s*%$/.exec(String(h.list_below).trim());
    listBelow = m ? Number(m[1]) : NaN;
    if (!(listBelow >= 0 && listBelow <= 100)) throw new Error("helpful.list_below is a share from 0% to 100%, such as 60%.");
  }
  const minAnswers = h.min_answers ?? 10;
  if (!Number.isInteger(minAnswers) || (minAnswers as number) < 1 || (minAnswers as number) > 100_000) throw new Error("helpful.min_answers is 1 or more.");

  const plans: Plan[] = [];
  const p = doc.plans ?? {};
  if (!isObj(p)) throw new Error("plans is a map of plan id to { name }, such as business: { name: Business plan }.");
  if (Object.keys(p).length > 50) throw new Error("plans holds at most 50 plans.");
  for (const [id, v] of Object.entries(p)) {
    if (!NAME.test(id)) throw new Error(`plans.${id}: a plan id is up to 32 lowercase letters, digits and -.`);
    if (v !== null && v !== undefined && !isObj(v)) throw new Error(`plans.${id} is a map with name.`);
    if (isObj(v)) keys(v, `plans.${id}`, ["name"]);
    plans.push({ id, name: isObj(v) && v.name !== undefined ? text(v.name, `plans.${id}.name`) : id });
  }

  const rd = doc.readers ?? {};
  if (!isObj(rd)) throw new Error("readers is a map with key.");
  keys(rd, "readers", ["key"]);
  const key = rd.key ?? "KNOWLEDGE_BASE_READER_KEY";
  if (typeof key !== "string" || !ENV.test(key))
    throw new Error("readers.key is the name of an environment variable, such as KNOWLEDGE_BASE_READER_KEY, never the key itself.");

  const sg = doc.suggest ?? {};
  if (!isObj(sg)) throw new Error("suggest is a map with in and sites.");
  keys(sg, "suggest", ["in", "sites"]);
  const places = sg.in ?? ["helpdesk-form", "live-chat"];
  if (!Array.isArray(places) || places.some((x) => !(PLACES as readonly string[]).includes(x as string)))
    throw new Error(`suggest.in is a list of ${PLACES.join(", ")}.`);
  const sites = sg.sites ?? [];
  if (!Array.isArray(sites) || sites.length > 50) throw new Error("suggest.sites is a list of up to 50 origins.");

  return {
    site: { name, address, languages, defaultLanguage, analytics },
    topics,
    review: { required: r.required !== false },
    helpful: { listBelow, minAnswers: minAnswers as number },
    plans,
    readers: { key },
    suggest: { in: [...new Set(places as Place[])], sites: [...new Set(sites.map((o, i) => origin(o, `suggest.sites[${i}]`)))] },
  };
}

export interface ConfigFileState {
  path: string;
  /** When the file was last read and applied, or null if it never was. */
  appliedAt: string | null;
  /** Why the file on disk is not what is applied; the last good version stays until it is fixed. */
  error: string | null;
  /** Things to fix that did not stop the file from being applied. */
  warnings: string[];
}

/**
 * Reads the file now and whenever it changes (checked every `everyMs`, by size, time and content), and hands each new
 * version and its text to `apply`, which returns warnings or throws to refuse it. A file that cannot be read or applied
 * leaves the last good version in place. `stop()` ends the polling.
 */
export function watchConfig(
  path: string,
  apply: (config: Config, text: string) => string[],
  { everyMs = 60_000, onChange }: { everyMs?: number; onChange?: (state: ConfigFileState) => void } = {},
) {
  const state: ConfigFileState = { path, appliedAt: null, error: null, warnings: [] };
  let seen = "";
  const read = () => {
    let raw: string;
    let stamp: string;
    try {
      const st = statSync(path);
      raw = readFileSync(path, "utf8");
      stamp = `${st.size}:${st.mtimeMs}:${createHash("sha256").update(raw).digest("hex")}`;
    } catch (err) {
      const error = `Cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`;
      if (state.error !== error) ((state.error = error), onChange?.(state));
      return;
    }
    if (stamp === seen) return;
    seen = stamp;
    try {
      state.warnings = apply(parseConfig(raw), raw);
      Object.assign(state, { appliedAt: new Date().toISOString(), error: null });
    } catch (err) {
      state.error = (err as Error).message;
    }
    onChange?.(state);
  };
  read();
  const timer = setInterval(read, everyMs);
  timer.unref();
  return { state, read, stop: () => clearInterval(timer) };
}
