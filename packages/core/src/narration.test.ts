import { describe, it, expect } from "vitest";
import type { ChangeManifest } from "@gitiviz/schema";
import { validateChangeManifest } from "@gitiviz/schema";
import {
  applyNarration,
  applyTemplateNarration,
  buildNarrationRequest,
  templateNarrator
} from "./narration.js";

const HOSTILE_LABEL = '<img src=x onerror=alert(1)>.ts';

/** A small manifest shaped like real Task-11/12 output. */
const makeManifest = (): ChangeManifest => ({
  specVersion: "0.1.0",
  repository: { name: "fixture" },
  baseRevision: "a".repeat(40),
  headRevision: "b".repeat(40),
  entities: [
    {
      id: "ent-route",
      kind: "route",
      humanLabel: "POST /orders",
      technicalLabel: "POST /orders",
      baseState: "removed",
      headState: "added",
      provenance: "derived",
      evidence: [{ path: "src/routes/orders.ts" }]
    },
    {
      id: "ent-hostile",
      kind: "file",
      humanLabel: HOSTILE_LABEL,
      baseState: "changed",
      headState: "changed",
      provenance: "derived",
      evidence: [{ path: HOSTILE_LABEL }]
    }
  ],
  relationships: [
    {
      id: "rel-1",
      from: "ent-route",
      to: "ent-hostile",
      verb: "reads",
      baseState: "unchanged",
      headState: "unchanged",
      provenance: "derived"
    }
  ],
  changeUnits: [
    {
      id: "unit-1",
      technicalTitle: "feat: add guest checkout route",
      humanTitle: null,
      type: "commit",
      commits: ["c".repeat(40)],
      entities: ["ent-route"],
      provenance: "derived"
    },
    {
      id: "unit-2",
      technicalTitle: "style: reformat orders routes",
      humanTitle: null,
      type: "commit",
      commits: ["d".repeat(40)],
      entities: [],
      grouped: true,
      groupedReason: "whitespace-only change (git diff -w is empty)",
      provenance: "derived"
    }
  ],
  analysisLimitations: [{ message: "no AST parse in v0.1" }]
});

describe("buildNarrationRequest", () => {
  it("contains the allowed id lists and facts only — no narration slots", () => {
    const request = buildNarrationRequest(makeManifest());
    expect(request.allowedEntityIds).toEqual(["ent-route", "ent-hostile"]);
    expect(request.allowedChangeUnitIds).toEqual(["unit-1", "unit-2"]);
    expect(request.changeUnits.map((u) => u.technicalTitle)).toEqual([
      "feat: add guest checkout route",
      "style: reformat orders routes"
    ]);
    // Facts only: narration slots must not exist on request records.
    for (const unit of request.changeUnits as unknown as Record<string, unknown>[]) {
      expect(unit).not.toHaveProperty("humanTitle");
      expect(unit).not.toHaveProperty("summary");
      expect(unit).not.toHaveProperty("userImpact");
    }
    // Grouped classification is a fact the narrator needs.
    expect(request.changeUnits[1]!.grouped).toBe(true);
  });

  it("carries hostile repo strings as inert JSON data and round-trips", () => {
    const request = buildNarrationRequest(makeManifest());
    const entity = request.entities.find((e) => e.id === "ent-hostile")!;
    expect(entity.humanLabel).toBe(HOSTILE_LABEL);
    expect(JSON.parse(JSON.stringify(request))).toEqual(request);
  });
});

describe("applyNarration — merge", () => {
  it("merges narration into slots and stamps provenance inferred with confidence", () => {
    const result = applyNarration(makeManifest(), {
      entities: [{ id: "ent-route", humanLabel: "Order creation", confidence: 0.8 }],
      changeUnits: [
        {
          id: "unit-1",
          humanTitle: "Guests can now check out",
          summary: "Adds a checkout route for guests.",
          beforeDescription: "Only signed-in users could order.",
          afterDescription: "Guests can order without an account.",
          userImpact: "Fewer abandoned carts.",
          openQuestions: ["Should guest orders expire?"],
          confidence: 0.7
        }
      ]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entity = result.value.entities.find((e) => e.id === "ent-route")!;
    expect(entity.humanLabel).toBe("Order creation");
    expect(entity.provenance).toBe("inferred");
    expect(entity.confidence).toBe(0.8);
    // Derived facts survive the merge untouched.
    expect(entity.baseState).toBe("removed");
    expect(entity.headState).toBe("added");
    expect(entity.evidence).toEqual([{ path: "src/routes/orders.ts" }]);

    const unit = result.value.changeUnits.find((u) => u.id === "unit-1")!;
    expect(unit.humanTitle).toBe("Guests can now check out");
    expect(unit.summary).toBe("Adds a checkout route for guests.");
    expect(unit.userImpact).toBe("Fewer abandoned carts.");
    expect(unit.openQuestions).toEqual(["Should guest orders expire?"]);
    expect(unit.provenance).toBe("inferred");
    expect(unit.confidence).toBe(0.7);
    // The derived technical title is never narration's to change.
    expect(unit.technicalTitle).toBe("feat: add guest checkout route");
  });

  it("leaves untouched records derived and their slots null when narration is missing", () => {
    const result = applyNarration(makeManifest(), {
      changeUnits: [{ id: "unit-1", humanTitle: "Guests can now check out" }]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const narrated = result.value.changeUnits.find((u) => u.id === "unit-1")!;
    // Slots the response did not fill stay null/absent.
    expect(narrated.summary ?? null).toBeNull();
    expect(narrated.userImpact ?? null).toBeNull();
    const untouched = result.value.changeUnits.find((u) => u.id === "unit-2")!;
    expect(untouched.provenance).toBe("derived");
    expect(untouched.humanTitle).toBeNull();
    for (const entity of result.value.entities) {
      expect(entity.provenance).toBe("derived");
    }
  });

  it("accepts an empty response as a no-op", () => {
    const manifest = makeManifest();
    const result = applyNarration(manifest, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(manifest);
  });

  it("does not mutate the input manifest", () => {
    const manifest = makeManifest();
    const snapshot = structuredClone(manifest);
    applyNarration(manifest, {
      changeUnits: [{ id: "unit-1", humanTitle: "New title" }]
    });
    expect(manifest).toEqual(snapshot);
  });

  it("produces a manifest that still validates against the schema", () => {
    const result = applyNarration(makeManifest(), {
      entities: [{ id: "ent-route", humanLabel: "Order creation" }],
      changeUnits: [{ id: "unit-1", humanTitle: "Guests can now check out" }]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validateChangeManifest(result.value).ok).toBe(true);
  });
});

describe("applyNarration — rejection rules", () => {
  it("rejects unknown changeUnit ids with an actionable error list", () => {
    const result = applyNarration(makeManifest(), {
      changeUnits: [
        { id: "unit-1", humanTitle: "ok" },
        { id: "unit-fabricated", humanTitle: "made up" }
      ]
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("unit-fabricated"))).toBe(true);
    expect(result.errors.some((e) => e.includes("unknown"))).toBe(true);
  });

  it("rejects unknown entity ids", () => {
    const result = applyNarration(makeManifest(), {
      entities: [{ id: "ent-fabricated", humanLabel: "ghost" }]
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("ent-fabricated"))).toBe(true);
  });

  it("rejects attempts to set non-narration fields (evidence, states, titles)", () => {
    for (const forbidden of [
      { id: "unit-1", humanTitle: "x", evidence: [{ path: "faked.ts" }] },
      { id: "unit-1", humanTitle: "x", technicalTitle: "rewritten" },
      { id: "unit-1", humanTitle: "x", grouped: false }
    ]) {
      const result = applyNarration(makeManifest(), { changeUnits: [forbidden] });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const key = Object.keys(forbidden).find((k) => k !== "id" && k !== "humanTitle")!;
      expect(result.errors.some((e) => e.includes(key))).toBe(true);
    }
    const entityResult = applyNarration(makeManifest(), {
      entities: [{ id: "ent-route", humanLabel: "x", baseState: "unchanged" }]
    });
    expect(entityResult.ok).toBe(false);
  });

  it("rejects a response claiming provenance (derived or otherwise)", () => {
    const result = applyNarration(makeManifest(), {
      changeUnits: [{ id: "unit-1", humanTitle: "x", provenance: "derived" }]
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("provenance"))).toBe(true);
  });

  it("rejects invalid confidence values", () => {
    for (const confidence of [1.5, -0.1, "high", Number.NaN]) {
      const result = applyNarration(makeManifest(), {
        changeUnits: [{ id: "unit-1", humanTitle: "x", confidence }]
      });
      expect(result.ok).toBe(false);
    }
  });

  it("rejects duplicate narration for the same id", () => {
    const result = applyNarration(makeManifest(), {
      changeUnits: [
        { id: "unit-1", humanTitle: "first" },
        { id: "unit-1", humanTitle: "second" }
      ]
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("duplicate"))).toBe(true);
  });

  it("rejects overlong narration strings instead of storing them", () => {
    const result = applyNarration(makeManifest(), {
      changeUnits: [{ id: "unit-1", humanTitle: "x".repeat(5000) }]
    });
    expect(result.ok).toBe(false);
  });

  it("never throws on malformed responses", () => {
    for (const malformed of [
      null,
      "not an object",
      42,
      [],
      { entities: "nope" },
      { changeUnits: [null] },
      { changeUnits: [{ humanTitle: "no id" }] },
      { changeUnits: [{ id: 7, humanTitle: "numeric id" }] },
      { changeUnits: [{ id: "unit-1", openQuestions: "not an array" }] },
      { changeUnits: [{ id: "unit-1", openQuestions: [1, 2] }] },
      { changeUnits: [{ id: "unit-1", humanTitle: 42 }] }
    ]) {
      const result = applyNarration(makeManifest(), malformed);
      expect(result.ok).toBe(false);
    }
  });

  it("collects all errors in one pass, not just the first", () => {
    const result = applyNarration(makeManifest(), {
      entities: [{ id: "ent-fabricated", humanLabel: "ghost" }],
      changeUnits: [{ id: "unit-1", humanTitle: "x", provenance: "derived" }]
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Concept diagrams and project narration
// ---------------------------------------------------------------------------

/** A valid architecture diagram whose only file anchor exists in the fixture. */
const makeArchitectureDiagram = () => ({
  clusters: [
    { id: "cluster-api", title: "API surface", tone: "blue" },
    { id: "cluster-data", title: "Data layer", tone: "amber" }
  ],
  nodes: [
    {
      id: "n-orders",
      cluster: "cluster-api",
      humanLabel: "Order intake",
      role: "accepts guest orders",
      file: "src/routes/orders.ts"
    },
    {
      id: "n-storage",
      cluster: "cluster-data",
      humanLabel: "Order storage",
      role: "persists orders"
    }
  ],
  edges: [{ from: "n-orders", to: "n-storage", verb: "writes to" }]
});

const makeStoryDiagram = () => ({
  nodes: [
    { id: "s-route", humanLabel: "Order intake", role: "new checkout route" },
    { id: "s-guests", humanLabel: "Guests", role: "can now order" }
  ],
  edges: [{ from: "s-guests", to: "s-route", verb: "now use" }]
});

describe("buildNarrationRequest — diagram grounding", () => {
  it("lists the evidence file inventory, sorted and de-duplicated", () => {
    const manifest = makeManifest();
    manifest.entities[0]!.evidence!.push({ path: "src/routes/orders.ts" });
    const request = buildNarrationRequest(manifest);
    expect(request.evidenceFiles).toEqual(
      [...request.evidenceFiles].sort()
    );
    expect(request.evidenceFiles).toEqual(
      [HOSTILE_LABEL, "src/routes/orders.ts"].sort()
    );
  });

  it("includes the overview system rollup and a per-unit story rollup", () => {
    const request = buildNarrationRequest(makeManifest());
    expect(Array.isArray(request.systemRollup.nodes)).toBe(true);
    expect(Array.isArray(request.systemRollup.edges)).toBe(true);
    for (const unit of request.changeUnits) {
      expect(Array.isArray(unit.storyRollup.nodes)).toBe(true);
      expect(Array.isArray(unit.storyRollup.edges)).toBe(true);
    }
  });

  it("states the diagram caps and the tone vocabulary", () => {
    const request = buildNarrationRequest(makeManifest());
    expect(request.diagramLimits.architecture.maxNodes).toBe(20);
    expect(request.diagramLimits.architecture.maxClusters).toBe(6);
    expect(request.diagramLimits.story.maxNodes).toBe(7);
    expect(request.diagramLimits.tones).toContain("blue");
    expect(request.diagramLimits.tones.length).toBe(6);
    // Still pure JSON.
    expect(JSON.parse(JSON.stringify(request))).toEqual(request);
  });
});

describe("applyNarration — concept diagrams", () => {
  it("accepts a valid architecture diagram and stamps it inferred", () => {
    const result = applyNarration(makeManifest(), {
      architectureDiagram: makeArchitectureDiagram()
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const diagram = result.value.architectureDiagram!;
    expect(diagram.provenance).toBe("inferred");
    expect(diagram.clusters).toHaveLength(2);
    expect(diagram.nodes).toHaveLength(2);
    expect(diagram.edges).toEqual([
      { from: "n-orders", to: "n-storage", verb: "writes to" }
    ]);
    expect(validateChangeManifest(result.value).ok).toBe(true);
  });

  it("accepts a story diagram on a change unit (clusters optional)", () => {
    const result = applyNarration(makeManifest(), {
      changeUnits: [{ id: "unit-1", storyDiagram: makeStoryDiagram() }]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const unit = result.value.changeUnits.find((u) => u.id === "unit-1")!;
    expect(unit.storyDiagram?.provenance).toBe("inferred");
    expect(unit.storyDiagram?.nodes).toHaveLength(2);
    expect(validateChangeManifest(result.value).ok).toBe(true);
  });

  it("rejects fabricated file paths with an actionable error", () => {
    const diagram = makeArchitectureDiagram();
    diagram.nodes[0]!.file = "src/does-not-exist.ts";
    const result = applyNarration(makeManifest(), {
      architectureDiagram: diagram
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.errors.some(
        (e) => e.includes("src/does-not-exist.ts") && e.includes("evidence")
      )
    ).toBe(true);
  });

  it("rejects an architecture diagram over the 20-node cap", () => {
    const diagram = makeArchitectureDiagram();
    diagram.nodes = Array.from({ length: 21 }, (_, i) => ({
      id: `n-${i}`,
      humanLabel: `Node ${i}`,
      role: "filler"
    })) as typeof diagram.nodes;
    diagram.edges = [];
    const result = applyNarration(makeManifest(), {
      architectureDiagram: diagram
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("20"))).toBe(true);
  });

  it("rejects an architecture diagram over the 6-cluster cap", () => {
    const diagram = makeArchitectureDiagram();
    diagram.clusters = Array.from({ length: 7 }, (_, i) => ({
      id: `c-${i}`,
      title: `Cluster ${i}`,
      tone: "blue"
    }));
    diagram.nodes = diagram.nodes.map((n) => ({ ...n, cluster: "c-0" }));
    const result = applyNarration(makeManifest(), {
      architectureDiagram: diagram
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("6"))).toBe(true);
  });

  it("rejects a story diagram over the 7-node cap", () => {
    const story = makeStoryDiagram();
    story.nodes = Array.from({ length: 8 }, (_, i) => ({
      id: `s-${i}`,
      humanLabel: `Node ${i}`,
      role: "filler"
    }));
    story.edges = [];
    const result = applyNarration(makeManifest(), {
      changeUnits: [{ id: "unit-1", storyDiagram: story }]
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("7"))).toBe(true);
  });

  it("rejects structural violations: dup ids, dangling refs, bad tone, empty verb", () => {
    const base = makeArchitectureDiagram;
    const broken: Array<(d: ReturnType<typeof base>) => void> = [
      (d) => d.nodes.push({ ...d.nodes[0]! }), // duplicate node id
      (d) => d.edges.push({ from: "n-ghost", to: "n-orders", verb: "haunts" }),
      (d) => {
        d.clusters[0]!.tone = "hotpink" as never;
      },
      (d) => {
        d.edges[0]!.verb = "";
      },
      (d) => {
        d.nodes[0]!.cluster = "cluster-ghost";
      },
      (d) => d.clusters.push({ ...d.clusters[0]! }) // duplicate cluster id
    ];
    for (const sabotage of broken) {
      const diagram = base();
      sabotage(diagram);
      const result = applyNarration(makeManifest(), {
        architectureDiagram: diagram
      });
      expect(result.ok).toBe(false);
    }
  });

  it("rejects a diagram claiming provenance (derived or otherwise)", () => {
    const result = applyNarration(makeManifest(), {
      architectureDiagram: { ...makeArchitectureDiagram(), provenance: "derived" }
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("provenance"))).toBe(true);
  });

  it("never throws on malformed diagrams", () => {
    for (const malformed of [
      "flowchart TD; a-->b", // raw Mermaid is structurally impossible
      42,
      [],
      { nodes: "nope" },
      { nodes: [null], edges: [] },
      { nodes: [{ id: "a" }], edges: [] },
      { nodes: [{ id: "a", humanLabel: "A", role: "r" }], edges: [null] },
      { nodes: [{ id: "a", humanLabel: "A", role: "r", file: 42 }], edges: [] },
      { clusters: "nope", nodes: [{ id: "a", humanLabel: "A", role: "r" }], edges: [] }
    ]) {
      expect(
        applyNarration(makeManifest(), { architectureDiagram: malformed }).ok
      ).toBe(false);
      expect(
        applyNarration(makeManifest(), {
          changeUnits: [{ id: "unit-1", storyDiagram: malformed }]
        }).ok
      ).toBe(false);
    }
  });
});

describe("applyNarration — project narration", () => {
  it("accepts projectSummary and chapter narrations, stamped inferred", () => {
    const result = applyNarration(makeManifest(), {
      projectSummary: "A fixture service that now accepts guest orders.",
      chapters: {
        purpose: {
          summary: "Exists so guests can order.",
          keyPoints: ["Guest checkout", "No account needed"]
        },
        systems: { summary: "One route talking to storage." },
        flows: { summary: "Order intake writes to storage." }
      }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.projectNarration?.summary).toBe(
      "A fixture service that now accepts guest orders."
    );
    expect(result.value.projectNarration?.provenance).toBe("inferred");
    const chapters = result.value.chapterNarrations!;
    expect(chapters.purpose?.provenance).toBe("inferred");
    expect(chapters.purpose?.keyPoints).toEqual([
      "Guest checkout",
      "No account needed"
    ]);
    expect(chapters.systems?.summary).toBe("One route talking to storage.");
    expect(chapters.flows?.provenance).toBe("inferred");
    expect(validateChangeManifest(result.value).ok).toBe(true);
  });

  it("rejects more than 5 keyPoints", () => {
    const result = applyNarration(makeManifest(), {
      chapters: {
        purpose: {
          summary: "ok",
          keyPoints: ["1", "2", "3", "4", "5", "6"]
        }
      }
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("5"))).toBe(true);
  });

  it("rejects unknown chapter slots and provenance claims", () => {
    expect(
      applyNarration(makeManifest(), {
        chapters: { journeys: { summary: "not narratable yet" } }
      }).ok
    ).toBe(false);
    expect(
      applyNarration(makeManifest(), {
        chapters: { purpose: { summary: "ok", provenance: "derived" } }
      }).ok
    ).toBe(false);
  });

  it("never throws on malformed project narration", () => {
    for (const malformed of [
      { projectSummary: 42 },
      { projectSummary: "" },
      { projectSummary: "x".repeat(5000) },
      { chapters: "nope" },
      { chapters: { purpose: null } },
      { chapters: { purpose: { keyPoints: ["no summary"] } } },
      { chapters: { purpose: { summary: 42 } } },
      { chapters: { purpose: { summary: "ok", keyPoints: "nope" } } }
    ]) {
      expect(applyNarration(makeManifest(), malformed).ok).toBe(false);
    }
  });
});

describe("templateNarrator", () => {
  it("produces deterministic dry narration for every ungrouped unit", () => {
    const request = buildNarrationRequest(makeManifest());
    const first = templateNarrator(request);
    const second = templateNarrator(request);
    expect(second).toEqual(first);
    const ids = (first.changeUnits ?? []).map((u) => u.id);
    expect(ids).toContain("unit-1");
    expect(ids).not.toContain("unit-2"); // grouped units stay timeline-only
    const unit = (first.changeUnits ?? []).find((u) => u.id === "unit-1")!;
    expect(unit.humanTitle).toBe("feat: add guest checkout route");
    expect(typeof unit.summary).toBe("string");
    expect(unit.summary!.length).toBeGreaterThan(0);
  });

  it("output passes applyNarration and the merged manifest validates", () => {
    const manifest = makeManifest();
    const response = templateNarrator(buildNarrationRequest(manifest));
    const result = applyNarration(manifest, response);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validateChangeManifest(result.value).ok).toBe(true);
  });

  it("applyTemplateNarration fills slots but keeps provenance derived (no AI marker)", () => {
    const manifest = makeManifest();
    const narrated = applyTemplateNarration(manifest);
    const unit = narrated.changeUnits.find((u) => u.id === "unit-1")!;
    expect(unit.humanTitle).toBe("feat: add guest checkout route");
    expect(unit.summary).toBeTruthy();
    // Deterministic restatement of derived facts is still derived — the
    // ◇ AI-interpretation marker is reserved for real agent narration.
    for (const u of narrated.changeUnits) {
      expect(u.provenance).toBe("derived");
      expect(u.confidence).toBeUndefined();
    }
    expect(validateChangeManifest(JSON.parse(JSON.stringify(narrated))).ok).toBe(true);
    // Input manifest untouched.
    expect(manifest.changeUnits[0]!.humanTitle ?? null).toBeNull();
  });

  it("stays dry on hostile technical titles (data in, data out, no crash)", () => {
    const manifest = makeManifest();
    manifest.changeUnits[0]!.technicalTitle = HOSTILE_LABEL;
    const response = templateNarrator(buildNarrationRequest(manifest));
    const unit = (response.changeUnits ?? []).find((u) => u.id === "unit-1")!;
    expect(unit.humanTitle).toBe(HOSTILE_LABEL);
    expect(applyNarration(manifest, response).ok).toBe(true);
  });
});
