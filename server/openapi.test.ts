import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, SITE, startApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "kb-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: Awaited<ReturnType<typeof startApp>>;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir });
  base = app.base;
});

afterAll(() => app.close());

/** Calls the API and checks status, content type and body against the description. */
async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);

  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1").replaceAll("{", "%7B").replaceAll("}", "%7D")}/${method.toLowerCase()}/responses/${res.status}`;

  if (!response.content) {
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined as any };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();

  const body = type.endsWith("json") ? await res.json() : await res.text();
  const schema = `${at}/content/${type.replace("/", "~1")}/schema`;
  const validate = ajv.getSchema(schema)!;
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return { res, body: body as any };
}

const admin = (b?: unknown) => ({
  headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
  ...(b !== undefined && { body: typeof b === "string" ? b : JSON.stringify(b) }),
});

describe("openapi.json", () => {
  it("has the version of this release", () => {
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    expect((await fetch(`${base}/api/docs/`)).headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/api/docs/../../package.json`)).status).not.toBe(200);
  });
});

describe("responses match openapi.json", () => {
  let id = "";

  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    await call("GET", "/api/v1/products", admin());
    await call("GET", "/api/v1/products", {});
    await call("GET", "/api/v1/summary", admin());
    await call("GET", "/api/v1/settings", admin());
    await call("GET", "/api/v1/settings", {});
    await call("GET", "/api/v1/team", admin());
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
  });

  it("articles", async () => {
    const created = await call(
      "POST",
      "/api/v1/articles",
      admin({ lang: "en", title: "Reset your password", body: "Click **Forgot password**.", topic: "account" }),
    );
    id = created.body.id;
    await call("POST", "/api/v1/articles", admin({ lang: "de", title: "x" }));
    await call("POST", "/api/v1/articles", admin("{"));
    await call("POST", "/api/v1/articles", admin({ lang: "en", title: "Again", slug: created.body.slug }));
    await call("POST", "/api/v1/articles", { body: "{}" });
    await call("GET", "/api/v1/articles", admin(), "/api/v1/articles?days=7");
    await call("GET", "/api/v1/articles", admin(), "/api/v1/articles?days=2");
    await call("GET", "/api/v1/articles", {});
    await call("GET", "/api/v1/articles/{id}", admin(), `/api/v1/articles/${id}`);
    await call("GET", "/api/v1/articles/{id}", admin(), "/api/v1/articles/missing");
    await call(
      "PATCH",
      "/api/v1/articles/{id}",
      admin({ translations: { tr: { title: "Şifrenizi sıfırlayın", body: "Tıklayın.", format: "markdown" } }, plans: [] }),
      `/api/v1/articles/${id}`,
    );
    await call("PATCH", "/api/v1/articles/{id}", admin({ topic: "nope" }), `/api/v1/articles/${id}`);
    await call("PATCH", "/api/v1/articles/{id}", admin({}), "/api/v1/articles/missing");
    await call("POST", "/api/v1/preview", admin({ body: "<b>x</b>", format: "html" }));
    await call("POST", "/api/v1/preview", admin({ body: 1 }));
    await call("POST", "/api/v1/import", admin({ format: "markdown", lang: "en", files: [{ name: "a.md", content: "# A\n\nB" }] }));
    await call("POST", "/api/v1/import", admin({ format: "pdf", files: [] }));
    await call("GET", "/api/v1/team", {});
  });

  it("review", async () => {
    await call("POST", "/api/v1/articles/{id}/submit", admin(), `/api/v1/articles/${id}/submit`);
    await call("POST", "/api/v1/articles/{id}/submit", admin(), `/api/v1/articles/${id}/submit`);
    await call("POST", "/api/v1/articles/{id}/approve", admin(), `/api/v1/articles/${id}/approve`);
    await call("POST", "/api/v1/articles/{id}/send-back", admin({ note: "Name the menu." }), `/api/v1/articles/${id}/send-back`);
    await call("POST", "/api/v1/articles/{id}/send-back", admin({ note: "Again." }), `/api/v1/articles/${id}/send-back`);
    await call("POST", "/api/v1/articles/{id}/submit", admin(), `/api/v1/articles/${id}/submit`);
    app.kb.approve({ id: "user-elif", name: "Elif Kaya" }, id);
    await call("POST", "/api/v1/articles/{id}/approve", admin(), "/api/v1/articles/missing/approve");
    await call("POST", "/api/v1/articles/{id}/unpublish", admin(), `/api/v1/articles/${id}/unpublish`);
    await call("POST", "/api/v1/articles/{id}/unpublish", admin(), `/api/v1/articles/${id}/unpublish`);
    await call("POST", "/api/v1/articles/{id}/submit", admin(), `/api/v1/articles/${id}/submit`);
    app.kb.approve({ id: "user-elif", name: "Elif Kaya" }, id);
  });

  it("suggestions", async () => {
    const page = { headers: { origin: SITE } };
    await call("GET", "/api/v1/suggest", page, "/api/v1/suggest?q=password&lang=en&place=helpdesk-form&sid=contract-sid-1");
    await call("GET", "/api/v1/suggest", page, "/api/v1/suggest?q=ihracat&lang=tr&place=live-chat&sid=contract-sid-2");
    await call("GET", "/api/v1/suggest", page, "/api/v1/suggest?q=x&place=email");
    await call("POST", "/api/v1/suggest/events", { ...page, body: JSON.stringify({ sid: "contract-sid-2", type: "ticket" }) });
    await call("POST", "/api/v1/suggest/events", { ...page, body: JSON.stringify({ sid: "x", type: "ticket" }) });
    await call("POST", "/api/v1/suggest/events", { ...page, body: "{" });
    await call("POST", "/api/v1/suggest/events", { headers: { origin: "https://evil.example" }, body: "{}" });
    await call("POST", "/api/v1/suggest/events", { ...page, body: "x".repeat(5000) });
    await call("GET", "/s/suggest.js");
  });

  it("reports and gaps", async () => {
    await fetch(`${base}/help/en/search?q=delete+my+account`);
    for (const path of ["/api/v1/report", "/api/v1/gaps", "/api/v1/suggestions"]) {
      await call("GET", path, admin(), `${path}?days=30`);
      await call("GET", path, admin(), `${path}?days=2`);
      await call("GET", path, {});
    }
    await call("POST", "/api/v1/gaps/dismiss", admin({ query: "delete my account", lang: "en" }));
    await call("POST", "/api/v1/gaps/dismiss", admin({ query: "" }));
    await call("POST", "/api/v1/gaps/dismiss", {});
  });

  it("reader links", async () => {
    await call("POST", "/api/v1/reader-links", admin({ plans: ["business"], minutes: 10, to: "/en/" }));
    await call("POST", "/api/v1/reader-links", admin({ plans: [] }));
    await call("POST", "/api/v1/reader-links", { body: "{}" });
    const noKey = await startApp({ version, settings: "readers: { key: NOT_SET_HERE }" });
    const res = await fetch(`${noKey.base}/api/v1/reader-links`, { method: "POST", ...admin({ plans: ["business"] }) });
    expect(res.status).toBe(409);
    await noKey.close();
  });

  it("deleting", async () => {
    await call("DELETE", "/api/v1/articles/{id}", admin(), `/api/v1/articles/${id}`);
    await call("DELETE", "/api/v1/articles/{id}", admin(), `/api/v1/articles/${id}`);
    await call("DELETE", "/api/v1/articles/{id}", {}, `/api/v1/articles/${id}`);
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});
