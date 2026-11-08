import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { READER_KEY, SITE, startApp } from "./test-app.ts";

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp({ version: "0.1.0" });
});
afterAll(() => app.close());

const json = async (res: Response) => (await res.json()) as any;
const ELIF = { id: "user-elif", name: "Elif Kaya" };
const html = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(app.base + path, { redirect: "manual", ...init });
  return { res, text: await res.text() };
};

/** Writes an article as the admin token and publishes it with a second person's approval. */
async function published(body: Record<string, unknown>, translations: Record<string, unknown> = {}) {
  const created = await json(await app.admin("/api/v1/articles", { method: "POST", body: JSON.stringify(body) }));
  if (Object.keys(translations).length) await app.admin(`/api/v1/articles/${created.id}`, { method: "PATCH", body: JSON.stringify({ translations }) });
  await app.admin(`/api/v1/articles/${created.id}/submit`, { method: "POST" });
  return app.kb.approve(ELIF, created.id);
}

describe("writing and publishing", () => {
  it("keeps a draft from readers until a second person approves it", async () => {
    const res = await app.admin("/api/v1/articles", {
      method: "POST",
      body: JSON.stringify({ lang: "tr", title: "Şifrenizi sıfırlayın", body: "Giriş sayfasında **Şifremi unuttum**'a tıklayın.", topic: "account" }),
    });
    expect(res.status).toBe(201);
    const a = await json(res);
    expect(a).toMatchObject({ slug: "sifrenizi-sifirlayin", state: "draft", live: false, owner: { id: "admin-token", name: "Admin token" } });
    expect((await html("/help/tr/articles/sifrenizi-sifirlayin")).res.status).toBe(404);

    const submitted = await json(await app.admin(`/api/v1/articles/${a.id}/submit`, { method: "POST" }));
    expect(submitted.state).toBe("review");
    const own = await app.admin(`/api/v1/articles/${a.id}/approve`, { method: "POST" });
    expect(own.status).toBe(409);
    expect((await json(own)).detail).toContain("A second person approves");

    const done = app.kb.approve(ELIF, a.id);
    expect(done).toMatchObject({ state: "published", live: true, reviewedBy: { name: "Elif Kaya" }, url: `${app.base}/help/tr/articles/sifrenizi-sifirlayin` });
    const page = await html("/help/tr/articles/sifrenizi-sifirlayin");
    expect(page.res.status).toBe(200);
    expect(page.text).toContain("<strong>Şifremi unuttum</strong>");
  });

  it("keeps the published words live while a change waits for review", async () => {
    const a = await published({ lang: "en", title: "Change your plan", body: "Open Billing.", topic: "getting-started" });
    const edited = await json(
      await app.admin(`/api/v1/articles/${a.id}`, {
        method: "PATCH",
        body: JSON.stringify({ translations: { en: { title: "Change your plan", body: "Open Billing, then Plans.", format: "markdown" } } }),
      }),
    );
    expect(edited).toMatchObject({ state: "draft", live: true });
    expect(edited.translations[0].published.html).toBe("<p>Open Billing.</p>");
    expect((await html("/help/en/articles/change-your-plan")).text).toContain("Open Billing.</p>");
    const back = app.kb.sendBack(ELIF, (await json(await app.admin(`/api/v1/articles/${a.id}/submit`, { method: "POST" }))).id, "Name the menu.");
    expect(back).toMatchObject({ state: "draft", note: "Name the menu." });
    const off = await json(await app.admin(`/api/v1/articles/${a.id}/unpublish`, { method: "POST" }));
    expect(off.live).toBe(false);
    expect((await html("/help/en/articles/change-your-plan")).res.status).toBe(404);
  });

  it("publishes at once when the file does not ask for review", async () => {
    const solo = await startApp({ version: "0.1.0", settings: "site: { languages: [en] }\nreview: { required: false }" });
    const a = await json(await solo.admin("/api/v1/articles", { method: "POST", body: JSON.stringify({ lang: "en", title: "Hello", body: "Hi." }) }));
    expect((await json(await solo.admin(`/api/v1/articles/${a.id}/submit`, { method: "POST" }))).state).toBe("published");
    await solo.close();
  });

  it("refuses what the settings file does not know", async () => {
    const post = (b: unknown) => app.admin("/api/v1/articles", { method: "POST", body: JSON.stringify(b) });
    expect((await json(await post({ lang: "de", title: "x" }))).detail).toContain("lang is one of the help center's languages: tr, en.");
    expect((await json(await post({ lang: "en", title: "x", topic: "nope" }))).detail).toContain("topic is the slug");
    expect((await json(await post({ lang: "en", title: "x", plans: ["gold"] }))).detail).toContain("plans is a list of plan ids");
    expect((await app.admin("/api/v1/articles", { method: "POST", body: "{" })).status).toBe(400);
    expect((await fetch(`${app.base}/api/v1/articles`)).status).toBe(401);
  });

  it("imports Markdown and HTML as drafts", async () => {
    const res = await app.admin("/api/v1/import", {
      method: "POST",
      body: JSON.stringify({
        format: "markdown",
        lang: "en",
        topic: "invoices",
        files: [
          { name: "send.md", content: "# Send your first e-Fatura\n\nIn Invoices, click **New invoice**." },
          { name: "other.md", content: "---\ntitle: Cancel an e-Arşiv invoice\nlang: tr\n---\nİptal edin." },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.created.map((a: any) => [a.title, a.languages, a.topic, a.state])).toEqual([
      ["Send your first e-Fatura", ["en"], "invoices", "draft"],
      ["Cancel an e-Arşiv invoice", ["tr"], "invoices", "draft"],
    ]);
  });

  it("previews the body as readers will see it, sanitized", async () => {
    const res = await app.admin("/api/v1/preview", {
      method: "POST",
      body: JSON.stringify({ format: "html", body: '<p onclick="x()">Hi<script>x()</script></p>' }),
    });
    expect(await json(res)).toEqual({ html: "<p>Hi</p>" });
  });
});

describe("the help center", () => {
  let invoice: string;
  beforeAll(async () => {
    const a = await published(
      { lang: "tr", title: "İlk e-Faturanızı gönderin", body: "Faturalar'da **Yeni fatura**'ya tıklayın.", topic: "invoices" },
      {
        en: {
          title: "Send your first e-Fatura <img src=x onerror=alert(1)>",
          body: 'In Invoices, click New invoice.<script>alert(1)</script><a href="javascript:x()">x</a>',
          format: "html",
        },
      },
    );
    invoice = a.slug;
  });

  it("sends readers to their language", async () => {
    const res = await fetch(`${app.base}/help/`, { redirect: "manual", headers: { "accept-language": "en-GB,en;q=0.9,tr;q=0.5" } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/help/en/");
    expect((await fetch(`${app.base}/help`, { redirect: "manual", headers: { "accept-language": "de" } })).headers.get("location")).toBe("/help/tr/");
  });

  it("lists topics and articles, with a search, in plain HTML", async () => {
    const { res, text } = await html("/help/tr/");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'none'");
    expect(text).toContain('<html lang="tr">');
    expect(text).toContain("Size nasıl yardımcı olabiliriz?");
    expect(text).toContain('href="/help/tr/topics/account">Hesap ve giriş</a>');
    expect(text).toContain('role="search"');
    expect((await html("/help/assets/help.css")).res.headers.get("content-type")).toBe("text/css; charset=utf-8");
  });

  it("escapes titles and shows bodies sanitized", async () => {
    const { text } = await html(`/help/en/articles/${invoice}`);
    expect(text).toContain("<h1>Send your first e-Fatura &lt;img src=x onerror=alert(1)&gt;</h1>");
    expect(text).not.toContain("<script>alert");
    expect(text).not.toContain("javascript:");
    expect(text).toContain('<article lang="en">');
  });

  it("shows the default language where an article has none in the reader's, and says so", async () => {
    const a = await published({ lang: "tr", title: "Banka hesabınızı bağlayın", body: "Banka'yı açın.", topic: "getting-started" });
    const { text } = await html(`/help/en/articles/${a.slug}`);
    expect(text).toContain('<article lang="tr">');
    expect(text).toContain("This article is not in English yet, so it is shown in Turkish.");
  });

  it("finds articles in any language, without accents, and keeps searches that found nothing", async () => {
    const { text } = await html("/help/en/search?q=sifre");
    expect(text).toContain("Şifrenizi sıfırlayın");
    expect(text).toMatch(/\?from=search&amp;s=[\w-]+/);
    const none = await html("/help/en/search?q=delete+my+account");
    expect(none.text).toContain("Nothing found for &quot;delete my account&quot;.");
    await html("/help/en/search?q=delete+my+account");
    const gaps = await json(await app.admin("/api/v1/gaps"));
    expect(gaps.gaps).toContainEqual(expect.objectContaining({ query: "delete my account", lang: "en", count: 2, places: ["help-center"] }));
    const dismissed = await app.admin("/api/v1/gaps/dismiss", { method: "POST", body: JSON.stringify({ query: "delete my account", lang: "en" }) });
    expect(dismissed.status).toBe(204);
    expect((await json(await app.admin("/api/v1/gaps"))).gaps.some((g: any) => g.query === "delete my account")).toBe(false);
  });

  it("closes a gap once an article is written for it", async () => {
    await html("/help/tr/search?q=mali+m%C3%BCh%C3%BCr");
    expect((await json(await app.admin("/api/v1/gaps"))).gaps.some((g: any) => g.query === "mali mühür")).toBe(true);
    await app.admin("/api/v1/articles", {
      method: "POST",
      body: JSON.stringify({ lang: "tr", title: "Mali mühür", gap: { query: "mali mühür", lang: "tr" } }),
    });
    expect((await json(await app.admin("/api/v1/gaps"))).gaps.some((g: any) => g.query === "mali mühür")).toBe(false);
  });

  it("counts views by where readers came from, and asks whether it helped", async () => {
    await fetch(`${app.base}/help/tr/articles/${invoice}`, { headers: { referer: "https://www.google.com/" } });
    await fetch(`${app.base}/help/tr/articles/${invoice}`, { headers: { "user-agent": "Googlebot/2.1" } });
    const vote = await fetch(`${app.base}/help/tr/articles/${invoice}/vote`, {
      method: "POST",
      redirect: "manual",
      body: "helpful=no",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(vote.status).toBe(303);
    expect(vote.headers.get("location")).toBe(`/help/tr/articles/${invoice}?voted=1#helpful`);
    expect((await html(`/help/tr/articles/${invoice}?voted=1`)).text).toContain("Teşekkürler.");
    const report = await json(await app.admin("/api/v1/report?days=7"));
    expect(report.sources).toContainEqual({ source: "google.com", views: 1 });
    const row = (await json(await app.admin("/api/v1/articles"))).articles.find((a: any) => a.slug === invoice);
    expect(row).toMatchObject({ votes: 1, helpful: 0 });
  });

  it("answers 404 in the reader's language for what is not there", async () => {
    const { res, text } = await html("/help/tr/articles/nope");
    expect(res.status).toBe(404);
    expect(text).toContain("Bu sayfa burada değil");
    expect((await html("/help/xx/")).res.status).toBe(404);
  });
});

describe("plan-only articles", () => {
  let slug: string;
  beforeAll(async () => {
    slug = (await published({ lang: "en", title: "Export the ledger for your accountant", body: "Open Reports.", topic: "invoices", plans: ["business"] }))
      .slug;
  });

  it("are hidden from everyone without a reader link", async () => {
    const { res, text } = await html(`/help/en/articles/${slug}`);
    expect(res.status).toBe(403);
    expect(text).not.toContain("Export the ledger");
    expect((await html("/help/en/search?q=ledger")).text).not.toContain("Export the ledger");
    expect((await html("/help/en/")).text).not.toContain("Export the ledger");
  });

  it("open for a reader whose signed link names the plan", async () => {
    const link = await json(
      await app.admin("/api/v1/reader-links", { method: "POST", body: JSON.stringify({ plans: ["business"], minutes: 30, to: `/en/articles/${slug}` }) }),
    );
    expect(link.url).toMatch(new RegExp(`^${app.base}/help/reader\\?token=`));
    const res = await fetch(link.url, { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/help/en/articles/${slug}`);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^kb_reader=v1\.[^;]+; Path=\/help; Max-Age=1800; HttpOnly; SameSite=Lax$/);
    const page = await html(`/help/en/articles/${slug}`, { headers: { cookie: cookie.split(";")[0]! } });
    expect(page.res.status).toBe(200);
    expect(page.res.headers.get("cache-control")).toBe("private, no-store");
    expect(page.text).toContain("For customers on Business plan");
  });

  it("refuse links that are not signed with the key, or have ended", async () => {
    const { token } = app.kb.signReader(["business"], 1);
    const forged = token.replace(/\.[^.]+$/, ".AAAA");
    expect((await html(`/help/reader?token=${encodeURIComponent(forged)}`)).res.status).toBe(400);
    expect((await html(`/help/en/articles/${slug}`, { headers: { cookie: `kb_reader=${encodeURIComponent(forged)}` } })).res.status).toBe(403);
    const other = await startApp({ version: "0.1.0" });
    const foreign = other.kb.signReader(["business"], 1).token;
    await other.close();
    expect(app.kb.readReader(foreign)).not.toBeNull(); // same test key in both
    app.clock.advance(120_000);
    expect(app.kb.readReader(token)).toBeNull();
    expect(READER_KEY.length).toBeGreaterThanOrEqual(32);
  });

  it("send the reader on only within the help center", async () => {
    const { token } = app.kb.signReader(["business"], 5);
    const res = await fetch(`${app.base}/help/reader?token=${encodeURIComponent(token)}&to=//evil.example`, { redirect: "manual" });
    expect(res.headers.get("location")).toMatch(/^\/help\/(tr|en)\/$/);
  });
});

describe("suggestions", () => {
  const sid = "form-session-0001";
  it("are offered to the sites in the file, as people type", async () => {
    const res = await fetch(`${app.base}/api/v1/suggest?q=reset+%C5%9Fifre&lang=en&place=helpdesk-form&sid=${sid}`, { headers: { origin: SITE } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(SITE);
    const body = await json(res);
    expect(body.search).toBe(sid);
    expect(body.articles[0]).toMatchObject({
      title: "Şifrenizi sıfırlayın",
      lang: "tr",
      url: `${app.base}/help/en/articles/sifrenizi-sifirlayin?from=helpdesk-form&s=${sid}`,
    });
  });

  it("are not readable by other origins, and what they send is not kept", async () => {
    const res = await fetch(`${app.base}/api/v1/suggest?q=ihracat&lang=tr&place=helpdesk-form&sid=evil-session-01`, {
      headers: { origin: "https://evil.example" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect((await json(res)).search).toBeNull();
    const ev = await fetch(`${app.base}/api/v1/suggest/events`, {
      method: "POST",
      body: JSON.stringify({ sid, type: "ticket" }),
      headers: { origin: "https://evil.example" },
    });
    expect(ev.status).toBe(403);
  });

  it("count a question answered when the form is closed after reading", async () => {
    await fetch(`${app.base}/help/en/articles/sifrenizi-sifirlayin?from=helpdesk-form&s=${sid}`);
    const ev = await fetch(`${app.base}/api/v1/suggest/events`, {
      method: "POST",
      body: JSON.stringify({ sid, type: "closed" }),
      headers: { origin: SITE, "content-type": "text/plain" },
    });
    expect(ev.status).toBe(202);
    expect(await json(ev)).toEqual({ recorded: true });
    const r = await json(await app.admin("/api/v1/suggestions"));
    expect(r.totals).toMatchObject({ shown: 1, opened: 1, answered: 1, ticket: 0 });
    expect(r.byPlace).toEqual([{ place: "helpdesk-form", shown: 1, opened: 1, answered: 1 }]);
    const row = (await json(await app.admin("/api/v1/articles"))).articles.find((a: any) => a.slug === "sifrenizi-sifirlayin");
    expect(row.answered).toBe(1);
  });

  it("list what the form asked that found nothing, and whether a ticket followed", async () => {
    await fetch(`${app.base}/api/v1/suggest?q=ihracat+faturas%C4%B1&lang=tr&place=live-chat&sid=chat-session-01`, { headers: { origin: SITE } });
    await fetch(`${app.base}/api/v1/suggest/events`, {
      method: "POST",
      body: JSON.stringify({ sid: "chat-session-01", type: "ticket" }),
      headers: { origin: SITE },
    });
    const gaps = await json(await app.admin("/api/v1/gaps"));
    expect(gaps.gaps).toContainEqual(expect.objectContaining({ query: "ihracat faturası", lang: "tr", count: 1, tickets: 1, places: ["live-chat"] }));
  });

  it("are previewed without being kept, and refuse unknown places", async () => {
    const before = (await json(await app.admin("/api/v1/suggestions"))).totals.shown;
    await fetch(`${app.base}/api/v1/suggest?q=reset&place=preview&sid=preview-sess-1`);
    expect((await json(await app.admin("/api/v1/suggestions"))).totals.shown).toBe(before);
    expect((await fetch(`${app.base}/api/v1/suggest?q=reset&place=email`)).status).toBe(422);
  });

  it("serve the script with the settings", async () => {
    const res = await fetch(`${app.base}/s/suggest.js`);
    expect(res.headers.get("content-type")).toBe("text/javascript");
    const text = await res.text();
    expect(text).toContain(`OAKB.start({"endpoint":"${app.base}/api/v1/suggest","events":"${app.base}/api/v1/suggest/events","languages":["tr","en"]`);
    expect(text).toContain('"tr":{"heading":"Bunlar sorunuzu yanıtlayabilir","helpful":"%{n} yararlı buldu"}');
  });
});

describe("reports and settings", () => {
  it("sum up the period", async () => {
    const r = await json(await app.admin("/api/v1/report"));
    expect(r.days).toBe(30);
    expect(r.languages).toEqual(["tr", "en"]);
    expect(r.series).toHaveLength(30);
    expect(r.totals.views).toBeGreaterThan(0);
    expect(r.totals.answered).toBe(1);
    expect(r.mostRead[0]).toHaveProperty("title");
    expect((await app.admin("/api/v1/report?days=2")).status).toBe(422);
  });

  it("show the file as applied", async () => {
    const s = await json(await app.admin("/api/v1/settings"));
    expect(s.yaml).toContain("default_language: tr");
    expect(s.config.plans).toEqual([{ id: "business", name: "Business plan" }]);
    expect(s.helpUrl).toBe(`${app.base}/help`);
  });
});

describe("a help center at its own address", () => {
  it("is served at the root of that host", async () => {
    const own = await startApp({ version: "0.1.0", settings: "site: { languages: [en], address: https://help.example.com }" });
    const port = new URL(own.base).port;
    const get = (path: string) =>
      new Promise<{ status: number; location?: string }>((resolve) =>
        request({ host: "localhost", port, path, headers: { host: "help.example.com", "accept-language": "en" } }, (res) => {
          res.resume();
          resolve({ status: res.statusCode!, location: res.headers.location });
        }).end(),
      );
    expect(await get("/")).toEqual({ status: 302, location: "/en/" });
    expect((await get("/en/")).status).toBe(200);
    expect((await get("/api/v1/articles")).status).toBe(404);
    expect(own.kb.helpUrl()).toBe("https://help.example.com");
    await own.close();
  });
});
