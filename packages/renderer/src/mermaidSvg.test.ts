/**
 * Build-time Mermaid rendering tests. These exercise the REAL mermaid
 * library under jsdom inside the Docker container — no browser, no network.
 */
import { describe, expect, it } from "vitest";
import type { BookManifest, ChangeManifest } from "@gitiviz/schema";
import { CHAPTER_IDS } from "@gitiviz/schema";
import { conceptDiagramToMermaid } from "./mermaid.js";
import {
  renderChangeBookWithMermaid,
  renderMermaidDiagram,
  sanitizeMermaidSvg
} from "./mermaidSvg.js";

const DIAGRAM = conceptDiagramToMermaid(
  {
    clusters: [{ id: "entry", title: "Entry & Runtime", tone: "blue" }],
    nodes: [
      {
        id: "cmd",
        cluster: "entry",
        humanLabel: "Claude slash commands",
        role: "command definitions",
        file: "commands/branch.md"
      },
      { id: "launcher", cluster: "entry", humanLabel: "Plugin launcher", role: "shell runtime" }
    ],
    edges: [{ from: "cmd", to: "launcher", verb: "invoke" }],
    provenance: "inferred",
    confidence: 0.9
  },
  {
    linkBase: "https://github.com/acme/demo/blob/abc123",
    existingFiles: new Set(["commands/branch.md"])
  }
);

describe("renderMermaidDiagram", () => {
  it("renders the compiled dialect to a standalone SVG with all label lines", async () => {
    const result = await renderMermaidDiagram("t1", DIAGRAM);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.svg.startsWith("<svg")).toBe(true);
    expect(result.svg).toContain("Claude");
    expect(result.svg).toContain("slash");
    expect(result.svg).toContain("launcher");
    expect(result.svg).toContain("runtime");
    expect(result.svg).toContain("invoke");
    expect(result.svg).toContain("Runtime"); // cluster title
  });

  it("keeps the sanitizer's guarantees: no scripts, no foreignObject, no handlers", async () => {
    const result = await renderMermaidDiagram("t2", DIAGRAM);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.svg).not.toContain("<script");
    expect(result.svg.toLowerCase()).not.toContain("foreignobject");
    expect(/\son[a-z]+=/i.test(result.svg)).toBe(false);
  });

  it("presents as an accessible image, not an interactive document", async () => {
    const result = await renderMermaidDiagram("t3", DIAGRAM);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.svg).toContain('role="img"');
    expect(result.svg).not.toContain("graphics-document");
  });

  it("keeps validated click-through links", async () => {
    const result = await renderMermaidDiagram("t4", DIAGRAM);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.svg).toContain("https://github.com/acme/demo/blob/abc123/commands/branch.md");
  });

  it("is byte-deterministic across renders", async () => {
    const a = await renderMermaidDiagram("t5", DIAGRAM);
    const b = await renderMermaidDiagram("t5", DIAGRAM);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.svg).toBe(b.svg);
  });

  it("fails honestly on unparseable mermaid text", async () => {
    const result = await renderMermaidDiagram("t6", "this is not mermaid at all ][");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("rejects unsafe DOM ids instead of interpolating them", async () => {
    const result = await renderMermaidDiagram('bad id"><script>', DIAGRAM);
    expect(result.ok).toBe(false);
  });
});

describe("sanitizeMermaidSvg", () => {
  it("strips scripts, foreignObject, event handlers, and unsafe hrefs", async () => {
    const hostile =
      `<svg viewBox="0 0 10 10"><script>alert(1)</script>` +
      `<foreignObject><div>html</div></foreignObject>` +
      `<g onload="alert(2)" onclick="alert(3)"><rect width="5" height="5"/></g>` +
      `<a href="javascript:alert(4)"><text>x</text></a>` +
      `<a href="#frag"><text>ok</text></a>` +
      `<a href="https://github.com/safe"><text>keep</text></a>` +
      `<image href="https://evil.example/x.png"/>` +
      `<use href="https://evil.example/defs.svg#a"/>` +
      `</svg>`;
    const clean = await sanitizeMermaidSvg(hostile);
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

  it("keeps the scoped style block but strips external url() references", async () => {
    const svg =
      `<svg><style>#d .n{fill:#fff;} #d .x{background:url(https://evil.example/a)} ` +
      `#d .m{marker-end:url(#arrow)}</style><rect width="1" height="1"/></svg>`;
    const clean = await sanitizeMermaidSvg(svg);
    expect(clean).not.toBeNull();
    expect(clean!).not.toContain("evil.example");
    expect(clean!).toContain("url(#arrow)");
  });

  it("returns null when the input has no svg root", async () => {
    expect(await sanitizeMermaidSvg("<div>not svg</div>")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End-to-end: renderChangeBookWithMermaid
// ---------------------------------------------------------------------------

function change(): ChangeManifest {
  return {
    specVersion: "0.1.0",
    repository: { name: "demo-app" },
    baseRevision: "a".repeat(40),
    headRevision: "b".repeat(40),
    entities: [
      {
        id: "ent-a",
        kind: "module",
        humanLabel: "Order service",
        baseState: "unchanged",
        headState: "changed",
        provenance: "derived",
        evidence: [{ path: "src/orderService.ts" }]
      }
    ],
    relationships: [],
    changeUnits: [
      {
        id: "unit-1",
        technicalTitle: "feat: add checkout",
        commits: ["c".repeat(40)],
        entities: ["ent-a"],
        provenance: "derived"
      }
    ],
    analysisLimitations: [],
    architectureDiagram: {
      clusters: [{ id: "core", title: "Core", tone: "amber" }],
      nodes: [
        { id: "svc", cluster: "core", humanLabel: "Order service", role: "order logic", file: "src/orderService.ts" }
      ],
      edges: [],
      provenance: "inferred",
      confidence: 0.9
    }
  };
}

function book(): BookManifest {
  return {
    specVersion: "0.1.0",
    repository: { name: "demo-app" },
    chapters: CHAPTER_IDS.map((id) => ({
      id,
      title: `Title for ${id}`,
      status: id === "systems" ? ("generated" as const) : ("not-written" as const)
    }))
  };
}

describe("renderChangeBookWithMermaid", () => {
  it("embeds real prerendered Mermaid SVG in the architecture view", async () => {
    const html = await renderChangeBookWithMermaid(book(), change());
    expect(html).toContain("<svg");
    // Mermaid wraps each label word in its own tspan, so assert per word
    // (the removed Diagram-source fold used to carry the contiguous text).
    expect(html).toContain("logic");
    // No fallback note on the architecture hero once Mermaid rendered.
    const archStart = html.indexOf('id="architecture"');
    const archEnd = html.indexOf("</section>", archStart);
    expect(html.slice(archStart, archEnd)).not.toContain("built-in diagram engine");
  });

  it("ships zero script tags and no event handlers", async () => {
    const html = await renderChangeBookWithMermaid(book(), change());
    expect(html).not.toContain("<script");
    expect(/\son[a-z]+=/i.test(html)).toBe(false);
  });

  it("is byte-deterministic end to end", async () => {
    const a = await renderChangeBookWithMermaid(book(), change());
    const b = await renderChangeBookWithMermaid(book(), change());
    expect(a).toBe(b);
  });
});
