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
