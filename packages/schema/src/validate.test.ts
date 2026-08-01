import { describe, it, expect } from "vitest";
import { validateChangeManifest } from "./validate.js";

const minimal = () => ({
  specVersion: "0.1.0",
  repository: { name: "fixture" },
  baseRevision: "a".repeat(40),
  headRevision: "b".repeat(40),
  entities: [],
  relationships: [],
  changeUnits: [],
  analysisLimitations: []
});

describe("change manifest validation", () => {
  it("accepts a minimal valid manifest", () => {
    expect(validateChangeManifest(minimal()).ok).toBe(true);
  });

  it("rejects unknown specVersion major", () => {
    const m = { ...minimal(), specVersion: "9.0.0" };
    expect(validateChangeManifest(m).ok).toBe(false);
  });

  it("rejects an entity without provenance", () => {
    const m = minimal();
    (m.entities as unknown[]).push({
      id: "e1",
      kind: "system",
      humanLabel: "X",
      baseState: "unchanged",
      headState: "unchanged"
    });
    expect(validateChangeManifest(m).ok).toBe(false);
  });

  it("rejects confidence on derived claims", () => {
    const m = minimal();
    (m.entities as unknown[]).push({
      id: "e1",
      kind: "system",
      humanLabel: "X",
      baseState: "unchanged",
      headState: "unchanged",
      provenance: "derived",
      confidence: 0.9
    });
    expect(validateChangeManifest(m).ok).toBe(false);
  });

  it("accepts confidence on inferred claims", () => {
    const m = minimal();
    (m.entities as unknown[]).push({
      id: "e1",
      kind: "system",
      humanLabel: "X",
      baseState: "unchanged",
      headState: "unchanged",
      provenance: "inferred",
      confidence: 0.9
    });
    expect(validateChangeManifest(m).ok).toBe(true);
  });

  it("rejects a relationship without a verb", () => {
    const m = minimal();
    (m.relationships as unknown[]).push({
      id: "r1",
      from: "e1",
      to: "e2",
      baseState: "unchanged",
      headState: "unchanged",
      provenance: "derived"
    });
    expect(validateChangeManifest(m).ok).toBe(false);
  });

  it("accepts concept diagrams and project narration slots", () => {
    const m = {
      ...minimal(),
      architectureDiagram: {
        clusters: [{ id: "c1", title: "API", tone: "blue" }],
        nodes: [
          { id: "n1", cluster: "c1", humanLabel: "Intake", role: "accepts orders", file: "src/a.ts" }
        ],
        edges: [{ from: "n1", to: "n1", verb: "loops" }],
        provenance: "inferred",
        confidence: 0.8
      },
      projectNarration: { summary: "A service.", provenance: "inferred" },
      chapterNarrations: {
        purpose: {
          summary: "Why it exists.",
          keyPoints: ["a", "b"],
          provenance: "inferred"
        }
      },
      changeUnits: [
        {
          id: "u1",
          technicalTitle: "feat: x",
          provenance: "derived",
          storyDiagram: {
            nodes: [{ id: "n1", humanLabel: "Intake", role: "route" }],
            edges: [],
            provenance: "inferred"
          }
        }
      ]
    };
    const result = validateChangeManifest(m);
    expect(result.ok).toBe(true);
  });

  it("rejects an architecture diagram beyond the 20-node schema cap", () => {
    const m = {
      ...minimal(),
      architectureDiagram: {
        nodes: Array.from({ length: 21 }, (_, i) => ({
          id: `n${i}`,
          humanLabel: `N${i}`,
          role: "filler"
        })),
        edges: [],
        provenance: "inferred"
      }
    };
    expect(validateChangeManifest(m).ok).toBe(false);
  });

  it("rejects a story diagram beyond the 7-node schema cap", () => {
    const m = minimal();
    (m.changeUnits as unknown[]).push({
      id: "u1",
      technicalTitle: "feat: x",
      provenance: "derived",
      storyDiagram: {
        nodes: Array.from({ length: 8 }, (_, i) => ({
          id: `n${i}`,
          humanLabel: `N${i}`,
          role: "filler"
        })),
        edges: [],
        provenance: "inferred"
      }
    });
    expect(validateChangeManifest(m).ok).toBe(false);
  });

  it("rejects an unknown diagram tone and unnarratable chapter slots", () => {
    const withTone = {
      ...minimal(),
      architectureDiagram: {
        clusters: [{ id: "c1", title: "API", tone: "hotpink" }],
        nodes: [{ id: "n1", humanLabel: "Intake", role: "route" }],
        edges: [],
        provenance: "inferred"
      }
    };
    expect(validateChangeManifest(withTone).ok).toBe(false);
    const withChapter = {
      ...minimal(),
      chapterNarrations: {
        journeys: { summary: "nope", provenance: "inferred" }
      }
    };
    expect(validateChangeManifest(withChapter).ok).toBe(false);
  });

  it("rejects more than 5 chapter keyPoints", () => {
    const m = {
      ...minimal(),
      chapterNarrations: {
        purpose: {
          summary: "ok",
          keyPoints: ["1", "2", "3", "4", "5", "6"],
          provenance: "inferred"
        }
      }
    };
    expect(validateChangeManifest(m).ok).toBe(false);
  });

  it("rejects confidence on a non-inferred diagram", () => {
    const m = {
      ...minimal(),
      architectureDiagram: {
        nodes: [{ id: "n1", humanLabel: "Intake", role: "route" }],
        edges: [],
        provenance: "derived",
        confidence: 0.9
      }
    };
    expect(validateChangeManifest(m).ok).toBe(false);
  });
});
