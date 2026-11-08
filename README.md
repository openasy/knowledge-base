# knowledge-base

[![CI](https://github.com/openasy/knowledge-base/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/knowledge-base/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Knowledge Base product: a public help center of articles by topic and
language, searchable, and suggested in the ticket form and the chat window before a ticket is opened. Support writes
an answer once; the team sees which articles helped, and which searches found nothing.

```
team ──▶ articles (draft ▶ review ▶ published) ──▶ /help/<lang>/...     the help center, plain HTML
                                              └──▶ /s/suggest.js ──▶ ticket form, chat window: articles as people type
readers ──▶ views, "did this help", searches that found nothing, forms closed after reading ──▶ reports
```

## The help center

Plain HTML pages made on the server, with one stylesheet and no script of their own: fast, readable without
JavaScript, and built for screen readers (a skip link, landmarks, `lang` on every page and on an article shown in
another language, labelled search and answers).

| Page | |
| --- | --- |
| `/help/` | Sends the reader to their language, from `Accept-Language` |
| `/help/<lang>/` | Search, popular articles and the topics |
| `/help/<lang>/topics/<slug>` | A topic's articles |
| `/help/<lang>/articles/<slug>` | An article, with "Did this help?" |
| `/help/<lang>/search?q=` | Search across all articles, in every language |

An article in the reader's language is shown in it; otherwise the default language's version is shown, with a note
saying so. The search folds case, accents and the Turkish dotted and dotless i, so `sifre` finds `Şifre`.

With `site.address` in the settings file, such as `https://help.example.com`, requests for that host are answered at
its root (`/tr/articles/...`). Point that name at Knowledge Base through your proxy and keep the `Host` header.
`/help/` keeps working on the product's own address.

`site.analytics` names an [Analytics](https://github.com/openasy/analytics) site's script; every help center page loads
it, so visits are measured there too. Views are also counted here, by day, language and where the reader came from,
without the reader's address or browser. Crawlers and prefetches are not counted.

## Suggestions in the ticket form and the chat window

```html
<script defer src="https://kb.example.com/s/suggest.js"></script>
<input name="subject" data-openasy-kb="helpdesk-form" />
```

A field marked `data-openasy-kb="<place>"` gets up to three articles under it as people type. Or attach it yourself:

```js
const kb = OpenAsyKB.attach({ input: "#message", place: "live-chat", lang: "tr", limit: 3, reader: tokenFromYourApp });
kb.done("ticket"); // the chat was started anyway
kb.done("closed"); // closed without one
```

Places are `helpdesk-form`, `live-chat`, `helpdesk-agent` and `app`; the file's `suggest.in` lists the ones used. Sending
the form the field is in counts as a ticket on its own, and leaving the page after opening an article counts as a
question answered. The script builds its list with `textContent` only and keeps nothing in the browser.

The script calls `GET /api/v1/suggest?q=&lang=&place=&sid=&limit=`, which Helpdesk may also call from its servers for
the suggestions agents see beside a ticket. Pages of the origins in `suggest.sites` may read the answer (CORS); what
other origins ask is answered without CORS and is not kept. With a `sid`, the form's last words are kept as one search,
so typing a subject is one search, not one per key. Searches are kept a year, with emails and long numbers masked.

## Plan-only articles

An article can be for customers of some plans only (`plans` in the settings file). The help center has no customer
accounts: the customer's own app, where they are signed in, says which plans they are on with a signed **reader link**.

```
https://kb.example.com/help/reader?token=<token>&to=/en/articles/export-the-ledger
```

The token is `v1.<payload>.<signature>`: the payload is base64url of `{"p": ["business"], "e": <expiry, Unix seconds>}`,
and the signature is base64url of HMAC-SHA256, with the key in the environment variable `readers.key` names, over
`v1.<payload>`. In Node:

```js
import { createHmac } from "node:crypto";
const body = `v1.${Buffer.from(JSON.stringify({ p: ["business"], e: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}`;
const token = `${body}.${createHmac("sha256", process.env.KNOWLEDGE_BASE_READER_KEY).update(body).digest("base64url")}`;
```

The link puts the token in an HttpOnly, SameSite=Lax cookie for the help center's path, up to its expiry (at most 30
days), and sends the reader on within the help center only. Pass the same token to the suggest script as `reader` to
suggest the plan's articles. Without a valid token, plan-only articles are left out of the topics, the search and the
suggestions, and their page answers 403 without their title; their pages are not cached and not indexed. The key must
be 32 characters or more; with no key, no reader link opens them. An admin can make a link to try one under
`POST /api/v1/reader-links`.

## Writing and publishing

Articles are written in the UI, in Markdown or HTML, one version per language. Review, by default, needs a second
person: the writer sends a draft for review, and someone else approves it (`review.required: false` lets writers
publish their own). A published article stays live while a change to it waits for review; the reviewer sees the blocks
that changed. Drafts and articles in review are seen only by the team.

**Import** takes Markdown files (front matter may give `title`, `topic`, `lang`, `slug` and `plans`; otherwise the first
`#` heading or the file name is the title) or HTML pages (their `<title>` or first `<h1>`), each a draft.

### Sanitizing

Every body is made into HTML and sanitized with [sanitize-html](https://github.com/apostrophecms/sanitize-html) when
it is written, and again when the help center shows it. Only an article's tags are kept (headings, paragraphs, lists,
emphasis, code, quotes, tables, figures, links and images); `class` only as `language-*` on code. Links go to http(s)
and mailto only and get `rel="noopener noreferrer nofollow"`; images come from http(s) or as PNG, JPEG, GIF or WebP
data. Scripts, styles, frames, forms, SVG, MathML and every event handler are removed. On top of that, the help center's
Content-Security-Policy runs no inline script and only the Analytics origin you name, and titles are always escaped.

## Reports

- **Overview**: views per day by language, where readers come from, searches and the share that found nothing,
  questions answered (forms and chats closed after an article), "did this help" answers, the most read articles, and the
  ones under `helpful.list_below` once they have `helpful.min_answers` answers, listed for their owner.
- **Gaps**: searches that found nothing in the help center, the ticket form and the chat window, how often, where, and
  whether a ticket followed. Writing an article for one links it to the draft, and the gap is no longer listed; a gap
  can also be set aside.
- **Suggestions**: shown, opened, questions answered and tickets opened anyway, by place, with a form to try them.

## The settings file

`/config/knowledge-base.yaml` (`KNOWLEDGE_BASE_CONFIG`), as in [config/knowledge-base.yaml](./config/knowledge-base.yaml).
No screen and no API route changes it. It is read at start and within a minute of a change, and applied whole or not
at all: a file with a mistake leaves the last good version in place, and the log and the Settings page say which field
to fix. Without a file, the help center starts in English with no topics.

| Field | Default | |
| --- | --- | --- |
| `site.name` | `Help center` | Shown on every page |
| `site.address` | | The help center's own `https://` origin; `<public url>/help` otherwise |
| `site.languages` | `[en]` | The languages articles are written in |
| `site.default_language` | the first | Shown where an article has no version in the reader's language |
| `site.analytics` | | An Analytics site's script, loaded on every help center page |
| `topics` | | Names, or `{ name, slug, names: { tr: ... } }` |
| `review.required` | `true` | A second person approves before an article is public |
| `helpful.list_below` | `60%` | Articles helpful less often are listed for their owner |
| `helpful.min_answers` | `10` | ...once they have this many answers |
| `plans` | | `id: { name }`, for plan-only articles |
| `readers.key` | `KNOWLEDGE_BASE_READER_KEY` | The environment variable holding the key that signs reader links. Never the key itself |
| `suggest.in` | `[helpdesk-form, live-chat]` | The places the suggest script runs in |
| `suggest.sites` | | The origins whose pages may read suggestions |

## Run

```bash
openssl rand -hex 32 > openasy-kek
$EDITOR config/knowledge-base.yaml
docker compose up -d
docker compose logs knowledge-base | grep 'no owner yet'
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013).

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `KNOWLEDGE_BASE_PUBLIC_URL` | `http://localhost:8080` | The address people open, with `https://` behind your TLS proxy |
| `KNOWLEDGE_BASE_CONFIG` | `/config/knowledge-base.yaml` | The settings file |
| `KNOWLEDGE_BASE_READER_KEY` | | The key reader links are signed with, when `readers.key` keeps its default name |
| `OPENASY_PRODUCTS` | | The install's other OpenAsy products, for the product switcher |
| `KNOWLEDGE_BASE_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key |
| `KNOWLEDGE_BASE_DB` | `/data/knowledge-base.db` | SQLite file (WAL), on the `/data` volume |
| `KNOWLEDGE_BASE_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `KNOWLEDGE_BASE_HEADLESS` | `false` | `true` serves no team UI; the help center and the API stay |
| `KNOWLEDGE_BASE_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in for the team, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)) |

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`. Readers'
searches, suggestions and help center pages are not written to the request log.

## Roles

Viewers see articles and reports; editors write, import, review and publish; admins also make reader links and manage
members and API tokens (ADR 0003). The help center and the suggest API need no sign-in.

## Develop

```bash
npm install
npm test        # settings, sanitizing, the help center, plan-only articles, suggestions, the script in jsdom, and every API response against openapi.json
npm run dev     # the UI, with the API on :8080
```

The team UI follows the Knowledge Base screens in the [ui](https://github.com/openasy/ui) Storybook. Its read-only
Settings page is rebuilt here from published components (`web/src/FileSettings.tsx`) until the shared page is in a
published `@openasy/ui`.

## Licence

AGPL-3.0 (ADR 0008).
