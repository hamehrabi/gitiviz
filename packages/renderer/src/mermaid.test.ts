import { describe, expect, it } from "vitest";
import type { ConceptDiagram } from "@gitiviz/schema";
import type { StoryProjection } from "@gitiviz/core";
import {
  MERMAID_TONE_CLASSDEFS,
  conceptDiagramToMermaid,
  storyProjectionToMermaid
} from "./mermaid.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function referenceDiagram(): ConceptDiagram {
  return {
    clusters: [
      { id: "entry", title: "Entry & Runtime", tone: "blue" },
      { id: "output", title: "Interchange & Report", tone: "mint" }
    ],
    nodes: [
      {
        id: "cmd",
        cluster: "entry",
        humanLabel: "Claude slash commands",
        role: "command definitions",
        file: "commands/branch.md"
      },
      {
        id: "launcher",
        cluster: "entry",
        humanLabel: "Plugin launcher",
        role: "shell runtime",
        file: "plugins/run.sh"
      },
      {
        id: "renderer",
        cluster: "output",
        humanLabel: "Scriptless HTML renderer",
        role: "report generator"
      },
      { id: "loose", humanLabel: "Loose concept", role: "no cluster" }
    ],
    edges: [
      { from: "cmd", to: "launcher", verb: "invoke" },
      { from: "launcher", to: "renderer", verb: "renders" }
    ],
    provenance: "inferred",
    confidence: 0.8
  };
}

const ALL_FILES = new Set(["commands/branch.md", "plugins/run.sh"]);

function demoStory(): StoryProjection {
  return {
    nodes: [
      { id: "sys-a", kind: "system", humanLabel: "Order flow", changeState: "changed", count: 3 },
      { id: "sys-b", kind: "component", humanLabel: "Checkout", changeState: "added", count: 1 },
      { id: "story:other", kind: "other", humanLabel: "Other changes", changeState: "removed", count: 2 }
    ],
    edges: [{ from: "sys-a", to: "sys-b", verb: "now uses" }]
  };
}

// ---------------------------------------------------------------------------
// conceptDiagramToMermaid — the visual-reference dialect
// ---------------------------------------------------------------------------

describe("conceptDiagramToMermaid", () => {
  it("opens with flowchart TD", () => {
    expect(conceptDiagramToMermaid(referenceDiagram()).startsWith("flowchart TD")).toBe(true);
  });

  it("renders three-line node labels: human name, role, [file]", () => {
    const text = conceptDiagramToMermaid(referenceDiagram());
    expect(text).toContain(
      'n0["Claude slash commands<br/>command definitions<br/>[commands/branch.md]"]'
    );
  });

  it("renders two-line labels when the node has no file", () => {
    const text = conceptDiagramToMermaid(referenceDiagram());
    expect(text).toContain('n2["Scriptless HTML renderer<br/>report generator"]');
    expect(text).not.toContain("report generator<br/>[");
  });

  it("wraps cluster members in a titled subgraph and leaves loose nodes outside", () => {
    const text = conceptDiagramToMermaid(referenceDiagram());
    // `&` neutralizes to Mermaid's own entity syntax (#amp; renders as &).
    const entry = /subgraph c0\["Entry #amp; Runtime"\]([\s\S]*?)end/.exec(text);
    expect(entry).not.toBeNull();
    expect(entry![1]).toContain("n0[");
    expect(entry![1]).toContain("n1[");
    expect(entry![1]).not.toContain("n3[");
    const afterSubgraphs = text.slice(text.lastIndexOf("\nend"));
    expect(afterSubgraphs).toContain('n3["Loose concept<br/>no cluster"]');
  });

  it("labels every edge with its quoted verb", () => {
    const text = conceptDiagramToMermaid(referenceDiagram());
    expect(text).toContain('n0 -->|"invoke"| n1');
    expect(text).toContain('n1 -->|"renders"| n2');
  });

  it("emits canonical palette classDefs for used tones only, and class lines per tone", () => {
    const text = conceptDiagramToMermaid(referenceDiagram());
    expect(text).toContain(`classDef toneBlue ${MERMAID_TONE_CLASSDEFS.blue}`);
    expect(text).toContain(`classDef toneMint ${MERMAID_TONE_CLASSDEFS.mint}`);
    expect(text).toContain(`classDef toneNeutral ${MERMAID_TONE_CLASSDEFS.neutral}`);
    expect(text).not.toContain("classDef toneRose");
    expect(text).not.toContain("classDef toneAmber");
    expect(text).toContain("class n0,n1 toneBlue");
    expect(text).toContain("class n2 toneMint");
    expect(text).toContain("class n3 toneNeutral");
  });

  it("matches the canonical visual-reference palette byte for byte", () => {
    expect(MERMAID_TONE_CLASSDEFS.neutral).toBe(
      "fill:#f8fafc,stroke:#334155,stroke-width:1.5px,color:#0f172a"
    );
    expect(MERMAID_TONE_CLASSDEFS.blue).toBe(
      "fill:#dbeafe,stroke:#2563eb,stroke-width:1.5px,color:#172554"
    );
    expect(MERMAID_TONE_CLASSDEFS.amber).toBe(
      "fill:#fef3c7,stroke:#d97706,stroke-width:1.5px,color:#78350f"
    );
    expect(MERMAID_TONE_CLASSDEFS.mint).toBe(
      "fill:#dcfce7,stroke:#16a34a,stroke-width:1.5px,color:#14532d"
    );
    expect(MERMAID_TONE_CLASSDEFS.rose).toBe(
      "fill:#ffe4e6,stroke:#e11d48,stroke-width:1.5px,color:#881337"
    );
  });

  it("never leaks spec-provided ids into the compiled text", () => {
    const diagram = referenceDiagram();
    diagram.nodes[0]!.id = "evil]--x";
    diagram.edges[0]!.from = "evil]--x";
    const text = conceptDiagramToMermaid(diagram);
    expect(text).not.toContain("evil]--x");
    expect(text).toContain('n0 -->|"invoke"| n1');
  });

  describe("click directives", () => {
    const linkBase = "https://github.com/acme/demo/blob/abc123";

    it("emits a click only for nodes whose file exists in the evidence index", () => {
      const text = conceptDiagramToMermaid(referenceDiagram(), {
        linkBase,
        existingFiles: new Set(["commands/branch.md"])
      });
      expect(text).toContain(
        'click n0 "https://github.com/acme/demo/blob/abc123/commands/branch.md" _blank'
      );
      expect(text).not.toContain("click n1");
    });

    it("emits no clicks without a configured link base", () => {
      const text = conceptDiagramToMermaid(referenceDiagram(), { existingFiles: ALL_FILES });
      expect(text).not.toContain("click ");
    });

    it("rejects an http link base unless its origin is explicitly allowed", () => {
      const httpBase = "http://git.internal/acme/demo/blob/abc123";
      const denied = conceptDiagramToMermaid(referenceDiagram(), {
        linkBase: httpBase,
        existingFiles: ALL_FILES
      });
      expect(denied).not.toContain("click ");
      const allowed = conceptDiagramToMermaid(referenceDiagram(), {
        linkBase: httpBase,
        allowedOrigins: ["http://git.internal"],
        existingFiles: ALL_FILES
      });
      expect(allowed).toContain('click n0 "http://git.internal/acme/demo/blob/abc123/commands/branch.md" _blank');
    });

    it("percent-encodes file path segments so hostile paths cannot break the directive", () => {
      const diagram = referenceDiagram();
      diagram.nodes[0]!.file = 'dir with space/a"b.ts';
      const text = conceptDiagramToMermaid(diagram, {
        linkBase,
        existingFiles: new Set(['dir with space/a"b.ts'])
      });
      expect(text).toContain(
        'click n0 "https://github.com/acme/demo/blob/abc123/dir%20with%20space/a%22b.ts" _blank'
      );
    });

    it("never emits a non-https/allowlisted scheme", () => {
      const text = conceptDiagramToMermaid(referenceDiagram(), {
        linkBase: "javascript:alert(1)//",
        existingFiles: ALL_FILES
      });
      expect(text).not.toContain("click ");
      expect(text).not.toContain("javascript:");
    });
  });

  describe("hostile labels", () => {
    it("neutralizes quote breakouts, markup, and newlines in every label position", () => {
      const diagram = referenceDiagram();
      diagram.clusters![0]!.title = '"]; click c0 "javascript:x"';
      diagram.nodes[0]!.humanLabel = '"] click n0 "javascript:alert(1)"';
      diagram.nodes[0]!.role = "<script>steal()</script>";
      diagram.nodes[0]!.file = 'a".ts\nclick n1 "javascript:y"';
      diagram.edges[0]!.verb = '"| n9 --> n8 |"';
      const text = conceptDiagramToMermaid(diagram);
      // No hostile string can mint a click directive — the fragments
      // survive only as inert entity-escaped label text (a "click" WORD
      // inside a quoted label is harmless; a click STATEMENT is not).
      expect(text).not.toMatch(/^click /m);
      expect(text).not.toContain("<script");
      expect(text).not.toContain('""]');
      // Raw double quotes from input are entity-escaped.
      expect(text).toContain("#quot;");
      // Newlines in labels collapse to spaces — one statement per line stays true.
      for (const line of text.split("\n")) {
        expect((line.match(/"/g) ?? []).length % 2).toBe(0);
      }
    });

    it("drops edges that reference undeclared nodes", () => {
      const diagram = referenceDiagram();
      diagram.edges.push({ from: "cmd", to: "ghost", verb: "haunts" });
      const text = conceptDiagramToMermaid(diagram);
      expect(text).not.toContain("haunts");
    });
  });

  it("is byte-deterministic", () => {
    const a = conceptDiagramToMermaid(referenceDiagram(), {
      linkBase: "https://github.com/acme/demo/blob/abc123",
      existingFiles: ALL_FILES
    });
    const b = conceptDiagramToMermaid(referenceDiagram(), {
      linkBase: "https://github.com/acme/demo/blob/abc123",
      existingFiles: ALL_FILES
    });
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// storyProjectionToMermaid — fallback stories
// ---------------------------------------------------------------------------

describe("storyProjectionToMermaid", () => {
  it("returns null for an empty projection", () => {
    expect(storyProjectionToMermaid({ nodes: [], edges: [] })).toBeNull();
  });

  it("renders two-line labels with the rolled-up change count", () => {
    const text = storyProjectionToMermaid(demoStory())!;
    expect(text.startsWith("flowchart TD")).toBe(true);
    expect(text).toContain('n0["Order flow<br/>updated · 3 changes"]');
    expect(text).toContain('n1["Checkout<br/>new · 1 change"]');
    expect(text).toContain('n2["Other changes<br/>2 changes"]');
  });

  it("labels edges with their plain-English verbs", () => {
    expect(storyProjectionToMermaid(demoStory())).toContain('n0 -->|"now uses"| n1');
  });

  it("maps change states to tones: added→mint, changed→blue, removed→rose, buckets→neutral", () => {
    const text = storyProjectionToMermaid(demoStory())!;
    expect(text).toContain("class n0 toneBlue");
    expect(text).toContain("class n1 toneMint");
    expect(text).toContain("class n2 toneNeutral");
  });

  it("caps at 7 nodes even for an oversized projection (defense in depth)", () => {
    const nodes = Array.from({ length: 9 }, (_, i) => ({
      id: `s${i}`,
      kind: "system",
      humanLabel: `Area ${i}`,
      changeState: "changed" as const,
      count: 1
    }));
    const text = storyProjectionToMermaid({ nodes, edges: [] })!;
    expect(text).toContain("n6[");
    expect(text).not.toContain("n7[");
  });

  it("is byte-deterministic", () => {
    expect(storyProjectionToMermaid(demoStory())).toBe(storyProjectionToMermaid(demoStory()));
  });
});
