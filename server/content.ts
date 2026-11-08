// An article's words: Markdown or HTML as it was written, made into HTML that is safe to put on the help center, and the
// plain text the search reads. Every body goes through sanitize() before it is stored, and again when it is shown, so a
// pasted or imported page cannot carry script, styles, frames, forms or event handlers to the help center's readers.
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { parse } from "yaml";

export type Format = "markdown" | "html";

/** Data URLs kept in images: pictures only. SVG is left out, as it can carry script when opened on its own. */
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;

const POLICY: sanitizeHtml.IOptions = {
  allowedTags: [
    "h2",
    "h3",
    "h4",
    "p",
    "br",
    "hr",
    "ul",
    "ol",
    "li",
    "strong",
    "em",
    "b",
    "i",
    "u",
    "s",
    "del",
    "ins",
    "mark",
    "sub",
    "sup",
    "small",
    "code",
    "kbd",
    "pre",
    "blockquote",
    "a",
    "img",
    "figure",
    "figcaption",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "dl",
    "dt",
    "dd",
    "details",
    "summary",
  ],
  allowedAttributes: {
    a: ["href", "title", "rel"],
    img: ["src", "alt", "title", "width", "height"],
    th: ["colspan", "rowspan", "scope"],
    td: ["colspan", "rowspan"],
    ol: ["start"],
    code: ["class"],
  },
  allowedClasses: { code: ["language-*"] },
  allowedSchemes: ["https", "http", "mailto"],
  allowedSchemesByTag: { img: ["https", "http", "data"] },
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  // The page's own heading is the article's title; headings inside start one level below.
  transformTags: {
    h1: "h2",
    a: (tagName, attribs) => {
      const href = attribs.href ?? "";
      const external = /^https?:/i.test(href);
      return {
        tagName,
        attribs: { ...(href && { href }), ...(attribs.title && { title: attribs.title }), ...(external && { rel: "noopener noreferrer nofollow" }) },
      };
    },
  },
  exclusiveFilter: (frame) => frame.tag === "img" && (!frame.attribs.src || (/^data:/i.test(frame.attribs.src) && !DATA_IMAGE.test(frame.attribs.src))),
};

/** HTML that is safe to show: only the tags and attributes an article needs, links only to http(s) and mailto. */
export function sanitize(html: string): string {
  return sanitizeHtml(html, POLICY).trim();
}

/** The body as HTML, sanitized, from what was written. */
export function render(body: string, format: Format): string {
  const html = format === "markdown" ? (marked.parse(body, { async: false, gfm: true, breaks: false }) as string) : body;
  return sanitize(html);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'", nbsp: " " };

/** The words of sanitized HTML, for the search and excerpts. */
export function plainText(html: string): string {
  const spaced = html.replace(/<(\/?(p|h[1-6]|li|td|th|dt|dd|br|hr|pre|blockquote|figcaption|summary|tr)\b)/gi, " <$1");
  return sanitizeHtml(spaced, { allowedTags: [], allowedAttributes: {} })
    .replace(/&(#?\w+);/g, (m, e: string) => ENTITIES[e.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

/** Up to `max` characters of the text, cut at a word. */
export function excerpt(text: string, max = 160): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 20)).trimEnd()}…`;
}

/**
 * Text as the search compares it: lowercase, without accents, and with Turkish dotted and dotless i alike, so "sifre"
 * finds "Şifre" and "Iptal" finds "iptal".
 */
export function fold(text: string): string {
  return text.replace(/[İI]/g, "i").toLowerCase().replace(/ı/g, "i").normalize("NFD").replace(/\p{M}/gu, "");
}

/** A search as it is kept: one line, at most 100 characters, emails and long numbers masked. */
export function cleanQuery(q: string): string {
  return q
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\s@]+@[^\s@]+/g, "[email]")
    .replace(/\d[\d\s-]{5,}\d/g, "[number]")
    .slice(0, 100)
    .trim();
}

export interface Imported {
  title: string;
  body: string;
  format: Format;
  /** From Markdown front matter, when it names them. */
  topic?: string;
  lang?: string;
  slug?: string;
  plans?: string[];
}

/** Reads one file from another help center: Markdown with optional front matter, or an HTML page. */
export function importFile(name: string, content: string, format: Format): Imported {
  const base = name
    .replace(/^.*[\\/]/, "")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  if (format === "markdown") {
    let body = content.replace(/^﻿/, "");
    const meta: Record<string, unknown> = {};
    const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body);
    if (fm) {
      try {
        const doc = parse(fm[1]!) as unknown;
        if (doc && typeof doc === "object" && !Array.isArray(doc)) Object.assign(meta, doc);
      } catch {
        // Front matter that is not YAML is left in the body for the writer to see.
      }
      if (Object.keys(meta).length) body = body.slice(fm[0].length);
    }
    let title = typeof meta.title === "string" ? meta.title.trim() : "";
    const h1 = /^\s*#\s+(.+?)\s*#*\s*$/m.exec(body);
    if (!title && h1 && body.slice(0, h1.index).trim() === "") {
      title = h1[1]!;
      body = body.slice(h1.index + h1[0].length);
    }
    return {
      title: (title || base || "Untitled").slice(0, 200),
      body: body.trim(),
      format,
      ...(typeof meta.topic === "string" && { topic: meta.topic }),
      ...(typeof meta.lang === "string" && { lang: meta.lang }),
      ...(typeof meta.slug === "string" && { slug: meta.slug }),
      ...(Array.isArray(meta.plans) && { plans: meta.plans.filter((p): p is string => typeof p === "string") }),
    };
  }
  let body = content;
  const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(body);
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
  if (bodyMatch) body = bodyMatch[1]!;
  let title = titleMatch ? plainText(titleMatch[1]!) : "";
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(body);
  if (h1) {
    if (!title) title = plainText(h1[1]!);
    if (plainText(h1[1]!) === title) body = body.slice(0, h1.index) + body.slice(h1.index + h1[0].length);
  }
  return { title: (title || base || "Untitled").slice(0, 200), body: sanitize(body), format };
}
