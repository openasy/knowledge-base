import { describe, expect, it } from "vitest";
import { cleanQuery, excerpt, fold, importFile, plainText, render, sanitize } from "./content.ts";

describe("sanitize", () => {
  it("keeps what an article needs", () => {
    const html =
      '<h2>Steps</h2><ol start="2"><li><strong>Open</strong> <a href="https://example.com/x">Settings</a></li></ol><img src="https://cdn.example.com/a.png" alt="Screen">';
    expect(sanitize(html)).toBe(
      '<h2>Steps</h2><ol start="2"><li><strong>Open</strong> <a href="https://example.com/x" rel="noopener noreferrer nofollow">Settings</a></li></ol><img src="https://cdn.example.com/a.png" alt="Screen" />',
    );
  });

  it.each([
    ["<script>alert(1)</script><p>ok</p>", "<p>ok</p>"],
    ['<img src="x" onerror="alert(1)">', '<img src="x" />'],
    ['<a href="javascript:alert(1)">x</a>', "<a>x</a>"],
    ['<a href="JaVaScRiPt:alert(1)">x</a>', "<a>x</a>"],
    ['<a href="&#106;avascript:alert(1)">x</a>', "<a>x</a>"],
    ['<a href="data:text/html,<script>alert(1)</script>">x</a>', "<a>x</a>"],
    ['<img src="data:image/svg+xml;base64,PHN2Zz4=">', ""],
    ['<img src="data:text/html;base64,PHNjcmlwdD4=">', ""],
    ['<iframe src="https://evil.example"></iframe><p>a</p>', "<p>a</p>"],
    ["<style>body{display:none}</style><p>a</p>", "<p>a</p>"],
    ['<p style="position:fixed" class="x" id="y">a</p>', "<p>a</p>"],
    ['<form action="https://evil.example"><input name="pw"></form>', ""],
    ['<svg onload="alert(1)"><circle /></svg>', ""],
    ['<math><mi xlink:href="javascript:alert(1)">x</mi></math>', "x"],
    ['<a href="//evil.example/x">x</a>', "<a>x</a>"],
    ['<object data="x.swf"></object><embed src="x">', ""],
    ['<meta http-equiv="refresh" content="0;url=https://evil.example">', ""],
    ['<base href="https://evil.example/">', ""],
  ])("removes %s", (input, out) => {
    expect(sanitize(input)).toBe(out);
  });

  it("is not fooled by markup that parses differently in a browser", () => {
    const out = sanitize('<p>a<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript></p>');
    expect(out).not.toMatch(/onerror|<img/);
  });

  it("keeps small pictures as data URLs, but not SVG", () => {
    expect(sanitize('<img src="data:image/png;base64,iVBORw0KGgo=" alt="">')).toBe('<img src="data:image/png;base64,iVBORw0KGgo=" alt="" />');
  });

  it("makes a h1 inside the body a h2, under the page's own title", () => {
    expect(sanitize("<h1>Title</h1>")).toBe("<h2>Title</h2>");
  });
});

describe("render", () => {
  it("turns Markdown into safe HTML, raw HTML in it too", () => {
    expect(render("# Reset\n\n1. Click **Forgot password**\n2. Type <script>x()</script>your email", "markdown")).toBe(
      "<h2>Reset</h2>\n<ol>\n<li>Click <strong>Forgot password</strong></li>\n<li>Type your email</li>\n</ol>",
    );
    expect(render("[x](javascript:alert(1))", "markdown")).toBe("<p><a>x</a></p>");
  });
});

describe("text", () => {
  it("reads the words of HTML", () => {
    expect(plainText("<h2>A &amp; B</h2><p>one</p><p>two&nbsp;three</p>")).toBe("A & B one two three");
  });

  it("cuts an excerpt at a word", () => {
    expect(excerpt("one two three four", 9)).toBe("one two…");
  });

  it("folds Turkish and accents alike", () => {
    expect(fold("Şifrenizi SIFIRLAYIN İptal e-Arşiv")).toBe("sifrenizi sifirlayin iptal e-arsiv");
  });

  it("keeps a search without emails or long numbers", () => {
    expect(cleanQuery("  Reset\n password for ali@example.com 0532 123 45 67  ")).toBe("reset password for [email] [number]");
  });
});

describe("import", () => {
  it("reads Markdown with front matter", () => {
    expect(importFile("reset.md", "---\ntitle: Reset your password\ntopic: account\nlang: en\nplans: [business]\n---\nSteps here.", "markdown")).toEqual({
      title: "Reset your password",
      body: "Steps here.",
      format: "markdown",
      topic: "account",
      lang: "en",
      plans: ["business"],
    });
  });

  it("takes the title from the first heading, or the file name", () => {
    expect(importFile("x.md", "# Change your plan\n\nOpen Billing.", "markdown")).toMatchObject({ title: "Change your plan", body: "Open Billing." });
    expect(importFile("folder/connect_your-bank.md", "Open Banking.", "markdown")).toMatchObject({ title: "connect your bank" });
  });

  it("reads an HTML page: its title, and its body sanitized", () => {
    const page =
      '<html><head><title>Export the ledger</title><script>x()</script></head><body><h1>Export the ledger</h1><p onclick="x()">Open Reports.</p></body></html>';
    expect(importFile("ledger.html", page, "html")).toEqual({ title: "Export the ledger", body: "<p>Open Reports.</p>", format: "html" });
  });
});
