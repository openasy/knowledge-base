// What the pages share: data loading with the session, formatting, the settings, and showing an article's HTML.
import { useAuth } from "@openasy/auth/react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, MfaSetupRequired, Unauthorized, type Config, type State } from "./api.ts";
import type { T } from "./i18n.ts";
import { viewerLocale } from "./i18n.ts";

/** Data loading with the session; when it ends, the sign-in screen comes back. */
export function useApi() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <R,>(path: string, init?: RequestInit): Promise<R> => {
      try {
        return await api<R>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}
export type Call = ReturnType<typeof useApi>;

/** Loads a path when it changes; `reload` loads it again. undefined while loading, null when it failed. */
export function useLoad<R>(call: Call, path: string | null) {
  const [data, setData] = useState<R | null>();
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    void call<R>(path).then(
      (d) => live && setData(d),
      () => live && setData(null),
    );
    return () => {
      live = false;
    };
  }, [call, path, n]);
  return [data, () => setN((x) => x + 1)] as const;
}

export function Code({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <pre aria-label={label} className="kb-code m-0 overflow-x-auto rounded-md bg-canvas px-2.5 py-2 font-mono text-2xs leading-relaxed text-fg">
      {children}
    </pre>
  );
}

/** A status line after something was done, read out by screen readers. */
export function Notice({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="kb-notice mb-2.5 rounded-md bg-success-soft px-3 py-2 text-sm text-fg">
      {children}
    </div>
  );
}

/**
 * An article's body. The server sanitized it when it was written (only article tags, http(s) and mailto links, no
 * script, styles or event handlers), and this page's Content-Security-Policy runs no inline script either.
 */
export function ArticleBody({ html, lang, className }: { html: string; lang?: string; className?: string }) {
  return <div lang={lang} className={`kb-article ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * The draft's top-level blocks that differ from the published version, wrapped in <ins>, so a reviewer sees what
 * changed. Both are the server's sanitized HTML; only the wrapper is added here.
 */
export function markChanges(draft: string, published: string | null): string {
  if (published === null || typeof DOMParser === "undefined") return draft;
  const parse = (html: string) => [...new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body.childNodes];
  const before = new Set(parse(published).map((n) => (n instanceof Element ? n.outerHTML : (n.textContent ?? "").trim())));
  return parse(draft)
    .map((n) => {
      const html = n instanceof Element ? n.outerHTML : (n.textContent ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
      const key = n instanceof Element ? n.outerHTML : (n.textContent ?? "").trim();
      return key && !before.has(key) ? `<ins class="kb-changed">${html}</ins>` : html;
    })
    .join("");
}

// ---------------------------------------------------------------- Formatting

export const fmt = (n: number) => n.toLocaleString(viewerLocale());
export const pct = (share: number) => `${Math.round(share * 1000) / 10}%`;
export const shortDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(viewerLocale(), { month: "short", day: "numeric", timeZone: "UTC" });
export const date = (iso: string) => new Date(iso).toLocaleDateString(viewerLocale(), { day: "numeric", month: "short" });

/** A language's own name: Türkçe, English, Deutsch. */
export function languageName(code: string) {
  try {
    const name = new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
    return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch {
    return code;
  }
}

/** A language's name in the page's language, for sentences. */
export function languageIn(code: string, locale: string) {
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export const STATE_TONE: Record<State, "success" | "warning" | "neutral"> = { published: "success", review: "warning", draft: "neutral" };

export function topicName(config: Config | null | undefined, slug: string | null, t: T) {
  if (!slug) return t("articles.noTopic");
  return config?.topics.find((x) => x.slug === slug)?.name ?? slug;
}

export function placeName(place: string, t: T) {
  const known: Record<string, string> = {
    "helpdesk-form": t("place.helpdeskForm"),
    "live-chat": t("place.liveChat"),
    "helpdesk-agent": t("place.helpdeskAgent"),
    app: t("place.app"),
    "help-center": t("place.helpCenter"),
    internal: t("place.internal"),
    search: t("place.search"),
    direct: t("place.direct"),
  };
  return known[place] ?? place;
}

/** Hostname of an address, for sentences: help.example.com. */
export const host = (url: string) => URL.parse(url)?.host ?? url;
