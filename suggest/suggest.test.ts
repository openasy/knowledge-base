// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attach, pickLanguage, start, type Config } from "./suggest.ts";

const config: Config = {
  endpoint: "https://kb.example/api/v1/suggest",
  events: "https://kb.example/api/v1/suggest/events",
  languages: ["tr", "en"],
  defaultLanguage: "tr",
  words: {
    en: { heading: "These may answer it", helpful: "{n}% found it helpful" },
    tr: { heading: "Bunlar sorunuzu yanıtlayabilir", helpful: "%{n} yararlı buldu" },
  },
};

let asked: URL[];
let beacons: Array<Record<string, string>>;

beforeEach(() => {
  vi.useFakeTimers();
  asked = [];
  beacons = [];
  document.body.innerHTML = '<form id="f"><input id="subject"></form>';
  document.documentElement.lang = "en";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      asked.push(new URL(url));
      return new Response(
        JSON.stringify({
          articles: [
            { id: "a1", title: '<img src=x onerror="alert(1)">Reset your password', excerpt: "", url: "https://help.example/en/articles/reset", helpful: 91 },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }),
  );
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: (_url: string, blob: Blob) => {
      void blob.text().then((t) => beacons.push(JSON.parse(t)));
      return true;
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const type = async (input: HTMLInputElement, text: string) => {
  input.value = text;
  input.dispatchEvent(new Event("input"));
  await vi.advanceTimersByTimeAsync(300);
};

describe("the suggest script", () => {
  it("asks once people stop typing, and lists the articles as text", async () => {
    const input = document.querySelector<HTMLInputElement>("#subject")!;
    attach(config, { input, place: "helpdesk-form" });
    await type(input, "re");
    expect(asked).toHaveLength(0);
    await type(input, "reset password");
    expect(asked).toHaveLength(1);
    expect(Object.fromEntries(asked[0]!.searchParams)).toMatchObject({ q: "reset password", lang: "en", place: "helpdesk-form", limit: "3" });
    const box = document.querySelector("section.openasy-kb")!;
    expect(box.getAttribute("aria-label")).toBe("These may answer it");
    expect(box.querySelector("img")).toBeNull();
    const link = box.querySelector("a")!;
    expect(link.textContent).toBe('<img src=x onerror="alert(1)">Reset your password');
    expect(link.getAttribute("href")).toBe("https://help.example/en/articles/reset");
    expect(box.textContent).toContain("91% found it helpful");
  });

  it("says a ticket was sent when the form is submitted", async () => {
    const input = document.querySelector<HTMLInputElement>("#subject")!;
    attach(config, { input, place: "helpdesk-form" });
    await type(input, "reset password");
    document.querySelector("form")!.dispatchEvent(new Event("submit"));
    await vi.advanceTimersByTimeAsync(0);
    expect(beacons).toEqual([{ sid: asked[0]!.searchParams.get("sid"), type: "ticket" }]);
  });

  it("says the question was answered when the page is left after opening an article", async () => {
    const input = document.querySelector<HTMLInputElement>("#subject")!;
    attach(config, { input, place: "live-chat" });
    await type(input, "reset password");
    document.querySelector<HTMLAnchorElement>("section.openasy-kb a")!.dispatchEvent(new MouseEvent("click", { cancelable: true }));
    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(0);
    expect(beacons.map((b) => b.type)).toEqual(["closed"]);
  });

  it("attaches to marked fields on its own", async () => {
    document.body.innerHTML = '<textarea data-openasy-kb="live-chat" data-openasy-kb-lang="tr"></textarea>';
    start(config);
    const field = document.querySelector("textarea")!;
    field.value = "şifre sıfırlama";
    field.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);
    expect(asked[0]!.searchParams.get("place")).toBe("live-chat");
    expect(asked[0]!.searchParams.get("lang")).toBe("tr");
    expect(window.OpenAsyKB).toBeDefined();
  });

  it("picks the reader's language among the help center's", () => {
    expect(pickLanguage(config, ["en-US"])).toBe("en");
    expect(pickLanguage(config, ["de"])).toBe("tr");
  });
});
