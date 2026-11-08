// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json.

/** Another OpenAsy product of this install, from OPENASY_PRODUCTS. */
export interface ProductLink {
  id: string;
  url: string;
}

/** The settings file and whether it is applied; null before it was first read. */
export type ConfigFile = {
  path: string;
  appliedAt: string | null;
  /** Why the file on disk is not applied; the last good version stays in use. */
  error: string | null;
  warnings: string[];
} | null;

export type State = "draft" | "review" | "published";
export type Format = "markdown" | "html";
export type Place = "helpdesk-form" | "live-chat" | "helpdesk-agent" | "app";

export interface Topic {
  slug: string;
  name: string;
  names: Record<string, string>;
}

export interface Config {
  site: { name: string; address: string | null; languages: string[]; defaultLanguage: string; analytics: string | null };
  topics: Topic[];
  review: { required: boolean };
  helpful: { listBelow: number; minAnswers: number };
  plans: Array<{ id: string; name: string }>;
  readers: { key: string };
  suggest: { in: Place[]; sites: string[] };
}

export interface Settings {
  config: Config | null;
  /** The file's text as applied. */
  yaml: string;
  file: ConfigFile;
  helpUrl: string;
}

export interface Summary {
  file: ConfigFile;
  helpUrl: string;
  siteName: string;
  articles: { total: number; published: number; review: number; draft: number };
  /** Different searches that found nothing in 30 days. */
  gaps: number;
}

export interface Person {
  id: string | null;
  name: string;
}

export interface Article {
  id: string;
  slug: string;
  topic: string | null;
  plans: string[];
  state: State;
  live: boolean;
  owner: Person;
  languages: string[];
  liveLanguages: string[];
  title: string;
  titles: Record<string, string>;
  views: number;
  helpful: number | null;
  votes: number;
  answered: number;
  updatedAt: string;
  publishedAt: string | null;
  submittedBy: Person | null;
  submittedAt: string | null;
  note: string | null;
  url: string | null;
}

export interface Translation {
  lang: string;
  title: string;
  format: Format;
  source: string;
  /** Sanitized by the server; safe to show. */
  html: string;
  published: { title: string; html: string } | null;
  updatedAt: string;
}

export interface ArticleDetail extends Article {
  translations: Translation[];
  reviewedBy: Person | null;
  gap: { query: string; lang: string } | null;
}

export interface Member {
  id: string;
  name: string;
  email: string;
}

export interface Report {
  days: number;
  from: string;
  languages: string[];
  totals: {
    views: number;
    viewsBefore: number;
    searches: number;
    noResult: number;
    answered: number;
    votes: number;
    helpful: number | null;
    articles: number;
    live: number;
    review: number;
  };
  series: Array<{ day: string; views: Record<string, number> }>;
  sources: Array<{ source: string; views: number }>;
  mostRead: Array<{ id: string; title: string; topic: string | null; views: number; answered: number }>;
  lowHelpful: Array<{ id: string; title: string; owner: Person; updatedAt: string; helpful: number; votes: number }>;
}

export interface Gap {
  query: string;
  lang: string;
  count: number;
  tickets: number;
  places: string[];
  last: string;
}

export interface Gaps {
  days: number;
  from: string;
  totals: { searches: number; noResult: number; share: number; shareBefore: number | null; tickets: number; different: number };
  gaps: Gap[];
}

export interface Suggestions {
  days: number;
  from: string;
  places: Place[];
  totals: { shown: number; opened: number; answered: number; ticket: number; answeredBefore: number };
  byPlace: Array<{ place: Place; shown: number; opened: number; answered: number }>;
}

export interface Suggested {
  lang: string;
  search: string | null;
  articles: Array<{ id: string; slug: string; lang: string; title: string; excerpt: string; topic: string | null; helpful: number | null; url: string }>;
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
