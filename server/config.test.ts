import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig, slugify, watchConfig } from "./config.ts";
import { SETTINGS } from "./test-app.ts";

describe("the settings file", () => {
  it("reads every setting", () => {
    expect(parseConfig(SETTINGS)).toEqual({
      site: { name: "Acme Help", address: null, languages: ["tr", "en"], defaultLanguage: "tr", analytics: null },
      topics: [
        { slug: "getting-started", name: "Getting started", names: {} },
        { slug: "account", name: "Account and sign-in", names: { tr: "Hesap ve giriş" } },
        { slug: "invoices", name: "Invoices and e-Fatura", names: {} },
      ],
      review: { required: true },
      helpful: { listBelow: 60, minAnswers: 2 },
      plans: [{ id: "business", name: "Business plan" }],
      readers: { key: "KB_READER_KEY" },
      suggest: { in: ["helpdesk-form", "live-chat"], sites: ["https://www.shop.example"] },
    });
  });

  it("has defaults for an empty file", () => {
    expect(parseConfig("")).toEqual({
      site: { name: "Help center", address: null, languages: ["en"], defaultLanguage: "en", analytics: null },
      topics: [],
      review: { required: true },
      helpful: { listBelow: 60, minAnswers: 10 },
      plans: [],
      readers: { key: "KNOWLEDGE_BASE_READER_KEY" },
      suggest: { in: ["helpdesk-form", "live-chat"], sites: [] },
    });
  });

  it("takes the help center's own address and an Analytics script", () => {
    const c = parseConfig("site:\n  address: https://help.example.com/\n  analytics: https://analytics.example.com/s/help.js");
    expect(c.site.address).toBe("https://help.example.com");
    expect(c.site.analytics).toBe("https://analytics.example.com/s/help.js");
  });

  it.each([
    ["nope: 1", "The file: unknown nope"],
    ["site: [1]", "site is a map"],
    ["site:\n  languages: [english]", "site.languages is a list"],
    ["site:\n  languages: [tr]\n  default_language: en", "site.default_language is one of site.languages: tr."],
    ["site:\n  address: http://help.example.com", "site.address is an origin with https://"],
    ["site:\n  analytics: javascript:alert(1)", "site.analytics is the address"],
    ["topics: [Banking, banking]", "topics[1]: the slug banking is in the file twice"],
    ["topics:\n  - { name: Banking, names: { de: Bank } }", "topics[0].names.de: de is not one of site.languages."],
    ["review: { required: maybe }", "review.required is true or false."],
    ["helpful: { list_below: 160% }", "helpful.list_below is a share"],
    ["plans: { Business: {} }", "plans.Business: a plan id"],
    ["readers: { key: s3cr3t-value }", "readers.key is the name of an environment variable"],
    ["suggest: { in: [email] }", "suggest.in is a list of helpdesk-form"],
    ["suggest: { sites: [example.com] }", "suggest.sites[0] is an origin"],
    ["a: [", "Not valid YAML"],
  ])("refuses %j", (text, message) => {
    expect(() => parseConfig(text)).toThrow(message);
  });

  it("makes slugs of names", () => {
    expect(slugify("Invoices and e-Fatura")).toBe("invoices-and-e-fatura");
    expect(slugify("Hesap ve Giriş İşlemleri")).toBe("hesap-ve-giris-islemleri");
  });

  it("is applied whole, and a file with a mistake leaves the last good one", () => {
    const path = join(mkdtempSync(join(tmpdir(), "kb-")), "knowledge-base.yaml");
    writeFileSync(path, "topics: [Banking]");
    const applied: string[][] = [];
    const watch = watchConfig(path, (c) => (applied.push(c.topics.map((t) => t.slug)), []), { everyMs: 1_000_000 });
    expect(watch.state.error).toBeNull();
    writeFileSync(path, "topics: [Banking, banking]");
    watch.read();
    expect(watch.state.error).toContain("twice");
    writeFileSync(path, "topics: [Banking, Billing]");
    watch.read();
    expect(watch.state.error).toBeNull();
    expect(applied).toEqual([["banking"], ["banking", "billing"]]);
    watch.stop();
  });
});
