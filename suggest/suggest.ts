// The suggest script for other sites: Helpdesk's ticket form, the Live Chat window, your app. Loaded from
// <knowledge base>/s/suggest.js, it shows the help center's articles under a field as people type, and says afterwards
// whether a ticket was still sent or the form was closed after reading. It builds its list with textContent only, so
// nothing in an article's title can run on the page, and it reads and writes no cookies or storage.

export interface Config {
  /** GET: articles for what is typed. */
  endpoint: string;
  /** POST: the form was sent as a ticket, or closed. */
  events: string;
  languages: string[];
  defaultLanguage: string;
  /** The script's words in each language: the list's heading, and "{n}% found it helpful". */
  words: Record<string, { heading: string; helpful: string }>;
}

export interface Suggested {
  id: string;
  title: string;
  excerpt: string;
  url: string;
  helpful: number | null;
}

export interface AttachOptions {
  /** The field people type in, or a selector for it. */
  input: HTMLInputElement | HTMLTextAreaElement | string;
  /** helpdesk-form, live-chat, helpdesk-agent or app: where the suggestions are shown. */
  place: string;
  /** The reader's language; the page's lang, then the browser's, when left out. */
  lang?: string;
  /** Where the list goes; right after the field when left out. */
  target?: HTMLElement | string;
  /** A reader token from your app, for customers who may read plan-only articles. */
  reader?: string;
  /** Articles shown, 1 to 5. Default 3. */
  limit?: number;
  /** Called with each new list, for pages that draw it themselves. */
  onResults?: (articles: Suggested[]) => void;
}

export interface Attached {
  /** Tell the knowledge base how it ended: "ticket" when the form is sent, "closed" when it is closed without. */
  done: (outcome: "ticket" | "closed") => void;
  destroy: () => void;
}

/** A random id for one open form, so its last words count as one search. */
export function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("");
}

/** The reader's language among the help center's. */
export function pickLanguage(config: Config, wanted: string[]): string {
  for (const w of wanted) {
    const l = w.toLowerCase();
    const hit = config.languages.find((x) => x.toLowerCase() === l) ?? config.languages.find((x) => x.toLowerCase().split("-")[0] === l.split("-")[0]);
    if (hit) return hit;
  }
  return config.defaultLanguage;
}

const element = <T extends Element>(v: T | string | undefined): T | null => (typeof v === "string" ? document.querySelector<T>(v) : (v ?? null));

export function attach(config: Config, opts: AttachOptions): Attached {
  const input = element<HTMLInputElement | HTMLTextAreaElement>(opts.input);
  if (!input) throw new Error("OpenAsy Knowledge Base: no field to attach to.");
  const lang = pickLanguage(
    config,
    [opts.lang, document.documentElement.lang, ...(navigator.languages ?? [navigator.language])].filter((x): x is string => !!x),
  );
  const words = config.words[lang.slice(0, 2)] ?? config.words.en ?? { heading: "These may answer it", helpful: "{n}% found it helpful" };
  const sid = randomId();
  const limit = Math.min(5, Math.max(1, opts.limit ?? 3));

  const box = document.createElement("section");
  box.className = "openasy-kb";
  box.setAttribute("aria-label", words.heading);
  box.setAttribute("aria-live", "polite");
  box.hidden = true;
  const target = element<HTMLElement>(opts.target);
  if (target) target.appendChild(box);
  else input.insertAdjacentElement("afterend", box);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: AbortController | undefined;
  let opened = false;
  let finished = false;
  let asked = false;

  function draw(articles: Suggested[]) {
    box.replaceChildren();
    opts.onResults?.(articles);
    if (!articles.length) {
      box.hidden = true;
      return;
    }
    const h = document.createElement("h3");
    h.className = "openasy-kb-heading";
    h.textContent = words.heading;
    const ul = document.createElement("ul");
    ul.className = "openasy-kb-list";
    for (const a of articles) {
      const li = document.createElement("li");
      const link = document.createElement("a");
      link.href = a.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = a.title;
      link.addEventListener("click", () => (opened = true));
      li.appendChild(link);
      if (a.helpful !== null) {
        const small = document.createElement("small");
        small.textContent = ` ${words.helpful.replace("{n}", String(a.helpful))}`;
        li.appendChild(small);
      }
      ul.appendChild(li);
    }
    box.append(h, ul);
    box.hidden = false;
  }

  async function ask() {
    const text = input!.value.trim();
    pending?.abort();
    if (text.length < 3) return draw([]);
    pending = new AbortController();
    const params = new URLSearchParams({ q: text.slice(0, 200), lang, place: opts.place, sid, limit: String(limit) });
    if (opts.reader) params.set("reader", opts.reader);
    try {
      const res = await fetch(`${config.endpoint}?${params}`, { signal: pending.signal, credentials: "omit" });
      if (!res.ok) return;
      const body = (await res.json()) as { articles: Suggested[] };
      asked = true;
      draw(body.articles);
    } catch {
      // Offline, or a newer question took over: the list stays as it was.
    }
  }

  const onInput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void ask(), 250);
  };
  input.addEventListener("input", onInput);

  function done(outcome: "ticket" | "closed") {
    if (finished || !asked) return;
    finished = true;
    const body = JSON.stringify({ sid, type: outcome });
    if (!navigator.sendBeacon?.(config.events, new Blob([body], { type: "text/plain" })))
      void fetch(config.events, { method: "POST", body, keepalive: true, credentials: "omit", headers: { "content-type": "text/plain" } }).catch(() => {});
  }

  // A form sent is a ticket; a page left after an article was opened is a question answered.
  const form = input.closest("form");
  const onSubmit = () => done("ticket");
  const onHide = () => opened && done("closed");
  form?.addEventListener("submit", onSubmit);
  window.addEventListener("pagehide", onHide);

  return {
    done,
    destroy: () => {
      clearTimeout(timer);
      pending?.abort();
      input.removeEventListener("input", onInput);
      form?.removeEventListener("submit", onSubmit);
      window.removeEventListener("pagehide", onHide);
      box.remove();
    },
  };
}

declare global {
  interface Window {
    OpenAsyKB?: { attach: (opts: AttachOptions) => Attached };
  }
}

/** Called by the served script with its settings. Fields marked data-openasy-kb="<place>" get suggestions on their own. */
export function start(config: Config) {
  window.OpenAsyKB = { attach: (opts) => attach(config, opts) };
  const auto = () => {
    for (const el of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-openasy-kb]")) {
      if (el.dataset.openasyKbAttached) continue;
      el.dataset.openasyKbAttached = "1";
      attach(config, { input: el, place: el.dataset.openasyKb || "helpdesk-form", lang: el.dataset.openasyKbLang });
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", auto);
  else auto();
}
