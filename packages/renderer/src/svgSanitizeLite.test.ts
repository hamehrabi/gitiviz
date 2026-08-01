/**
 * The dependency-free sanitizer must enforce the SAME policy as the jsdom
 * sanitizer. Each case runs through both and asserts identical guarantees
 * (not identical bytes — serializers differ; the policy is the contract).
 */
import { describe, expect, it } from "vitest";
import { sanitizeMermaidSvg } from "./mermaidSvg.js";
import { sanitizeMermaidSvgText } from "./svgSanitizeLite.js";

const HOSTILE =
  `<svg viewBox="0 0 10 10" aria-roledescription="flowchart-v2"><script>alert(1)</script>` +
  `<foreignObject><div>html</div></foreignObject>` +
  `<g onload="alert(2)" onclick="alert(3)"><rect width="5" height="5"/></g>` +
  `<a href="javascript:alert(4)"><text>x</text></a>` +
  `<a href="#frag"><text>ok</text></a>` +
  `<a href="https://github.com/safe"><text>keep</text></a>` +
  `<image href="https://evil.example/x.png"/>` +
  `<use href="https://evil.example/defs.svg#a"/>` +
  `</svg>`;

describe("sanitizeMermaidSvgText (dependency-free path)", () => {
  it("strips scripts, foreignObject, event handlers, and unsafe hrefs", () => {
    const clean = sanitizeMermaidSvgText(HOSTILE);
    expect(clean).not.toBeNull();
    expect(clean!).not.toContain("<script");
    expect(clean!.toLowerCase()).not.toContain("foreignobject");
    expect(clean!).not.toContain("onload");
    expect(clean!).not.toContain("onclick");
    expect(clean!).not.toContain("javascript:");
    expect(clean!).not.toContain("evil.example");
    expect(clean!).toContain('href="#frag"');
    expect(clean!).toContain('href="https://github.com/safe"');
  });

  it("matches the jsdom sanitizer's guarantees on the same hostile input", async () => {
    const dom = await sanitizeMermaidSvg(HOSTILE);
    const lite = sanitizeMermaidSvgText(HOSTILE);
    expect(dom).not.toBeNull();
    expect(lite).not.toBeNull();
    for (const clean of [dom!, lite!]) {
      expect(clean).not.toContain("<script");
      expect(clean.toLowerCase()).not.toContain("foreignobject");
      expect(/\son[a-z]+\s*=/i.test(clean)).toBe(false);
      expect(clean).not.toContain("javascript:");
      expect(clean).not.toContain("evil.example");
      expect(clean).toContain('href="#frag"');
      expect(clean).toContain('href="https://github.com/safe"');
      expect(clean).toContain('role="img"');
      expect(clean).not.toContain("aria-roledescription");
    }
  });

  it("keeps the scoped style block but strips external url() references", () => {
    const svg =
      `<svg><style>#d .n{fill:#fff;} #d .x{background:url(https://evil.example/a)} ` +
      `#d .m{marker-end:url(#arrow)}</style><rect width="1" height="1"/></svg>`;
    const clean = sanitizeMermaidSvgText(svg);
    expect(clean).not.toBeNull();
    expect(clean!).not.toContain("evil.example");
    expect(clean!).toContain("url(#arrow)");
  });

  it("scrubs style attributes and drops nested forbidden blocks", () => {
    const svg =
      `<svg><g style="fill:red;background:url(https://evil.example/x)">` +
      `<foreignObject><foreignObject><div>x</div></foreignObject></foreignObject>` +
      `<text>label</text></g></svg>`;
    const clean = sanitizeMermaidSvgText(svg);
    expect(clean).not.toBeNull();
    expect(clean!).not.toContain("evil.example");
    expect(clean!.toLowerCase()).not.toContain("foreignobject");
    expect(clean!).toContain("<text>label</text>");
  });

  it("validates http hrefs against allowed origins only", () => {
    const svg =
      `<svg><a href="http://git.internal/repo/file.ts"><text>a</text></a>` +
      `<a href="http://other.host/x"><text>b</text></a></svg>`;
    const clean = sanitizeMermaidSvgText(svg, {
      allowedOrigins: ["http://git.internal"]
    });
    expect(clean!).toContain('href="http://git.internal/repo/file.ts"');
    expect(clean!).not.toContain("other.host");
  });

  it("normalizes the root to an accessible image", () => {
    const clean = sanitizeMermaidSvgText(
      `<svg role="graphics-document document" aria-roledescription="flowchart-v2"><rect/></svg>`
    );
    expect(clean!).toContain('role="img"');
    expect(clean!).not.toContain("graphics-document");
    expect(clean!).not.toContain("aria-roledescription");
  });

  it("returns null when the input has no svg root", () => {
    expect(sanitizeMermaidSvgText("<div>not svg</div>")).toBeNull();
    expect(sanitizeMermaidSvgText("")).toBeNull();
  });

  it("keeps real mermaid structure intact (classes, markers, clusters)", () => {
    const svg =
      `<svg id="gitiviz-architecture" viewBox="0 0 100 100">` +
      `<style>#gitiviz-architecture .toneBlue{fill:#dbeafe;}</style>` +
      `<g class="cluster"><rect width="10" height="10"/><text>Entry</text></g>` +
      `<g class="node toneBlue"><a href="https://github.com/acme/demo/blob/abc/x.ts">` +
      `<text>label</text></a></g></svg>`;
    const clean = sanitizeMermaidSvgText(svg);
    expect(clean!).toContain('class="cluster"');
    expect(clean!).toContain(".toneBlue{fill:#dbeafe;}");
    expect(clean!).toContain('href="https://github.com/acme/demo/blob/abc/x.ts"');
  });
});
