import { describe, expect, it } from "vitest";
import { escAttr, escHtml, safeUrl } from "./escape.js";

describe("escHtml", () => {
  it("escapes the five HTML metacharacters", () => {
    expect(escHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("neutralizes a <script> filename", () => {
    const out = escHtml("<img src=x onerror=alert(1)>.ts");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
    expect(out).toContain("&gt;.ts");
  });

  it("neutralizes a <script> tag", () => {
    const out = escHtml("<script>alert(1)</script>");
    expect(out).not.toContain("<script");
    expect(out).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("leaves unicode intact", () => {
    expect(escHtml("héllo — päth/文件.ts 🚀")).toBe("héllo — päth/文件.ts 🚀");
  });

  it("passes plain strings through unchanged", () => {
    expect(escHtml("src/routes/orders.ts")).toBe("src/routes/orders.ts");
  });
});

describe("escAttr", () => {
  it("escapes quotes so attribute breakout fails", () => {
    const out = escAttr(`" onmouseover="alert(1)`);
    expect(out).not.toContain('"');
    expect(out).toContain("&quot;");
  });

  it("escapes single quotes too", () => {
    expect(escAttr("it's")).toBe("it&#39;s");
  });
});

describe("safeUrl", () => {
  it("accepts https URLs", () => {
    expect(safeUrl("https://github.com/x/y")).toBe("https://github.com/x/y");
  });

  it("rejects javascript: URLs", () => {
    expect(safeUrl("javascript:alert(1)")).toBeNull();
  });

  it("rejects javascript: URLs with case and whitespace tricks", () => {
    expect(safeUrl("JaVaScRiPt:alert(1)")).toBeNull();
    expect(safeUrl("  javascript:alert(1)")).toBeNull();
    expect(safeUrl("java\tscript:alert(1)")).toBeNull();
  });

  it("rejects data: URLs", () => {
    expect(safeUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  it("rejects plain http: URLs by default", () => {
    expect(safeUrl("http://example.com/repo")).toBeNull();
  });

  it("accepts an http origin only when explicitly allowlisted", () => {
    expect(
      safeUrl("http://git.internal:3000/repo", ["http://git.internal:3000"])
    ).toBe("http://git.internal:3000/repo");
    expect(
      safeUrl("http://evil.example/repo", ["http://git.internal:3000"])
    ).toBeNull();
  });

  it("rejects relative and malformed URLs", () => {
    expect(safeUrl("../../etc/passwd")).toBeNull();
    expect(safeUrl("not a url")).toBeNull();
    expect(safeUrl("")).toBeNull();
  });

  it("rejects file: and vbscript: schemes even when an allowlist is given", () => {
    expect(safeUrl("file:///etc/passwd", ["file://"])).toBeNull();
    expect(safeUrl("vbscript:msgbox(1)", ["vbscript:"])).toBeNull();
  });
});
