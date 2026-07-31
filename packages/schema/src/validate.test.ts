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
});
