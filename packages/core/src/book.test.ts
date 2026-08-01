import { describe, it, expect } from "vitest";
import type { ChangeManifest } from "@gitiviz/schema";
import { CHAPTER_IDS, validateBookManifest } from "@gitiviz/schema";
import { buildBookManifest } from "./book.js";

const HOSTILE_NAME = '<img src=x onerror=alert(1)>';

const makeManifest = (
  overrides: Partial<ChangeManifest> = {}
): ChangeManifest => ({
  specVersion: "0.1.0",
  repository: { name: "fixture" },
  baseRevision: "a".repeat(40),
  headRevision: "b".repeat(40),
  entities: [
    {
      id: "ent-app",
      kind: "system",
      humanLabel: "The application",
      baseState: "unchanged",
      headState: "unchanged",
      provenance: "derived"
    }
  ],
  relationships: [],
  changeUnits: [
    {
      id: "unit-1",
      technicalTitle: "feat: add orders route",
      provenance: "derived",
      commits: ["c".repeat(40)]
    }
  ],
  analysisLimitations: [],
  ...overrides
});

describe("buildBookManifest", () => {
  it("produces exactly ten chapters in canonical reading order", () => {
    const book = buildBookManifest(makeManifest());
    expect(book.chapters).toHaveLength(10);
    expect(book.chapters.map((c) => c.id)).toEqual([...CHAPTER_IDS]);
  });

  it("marks purpose, systems, and history as generated and the other seven as not-written", () => {
    const book = buildBookManifest(makeManifest());
    const statusOf = (id: string) =>
      book.chapters.find((c) => c.id === id)?.status;
    expect(statusOf("purpose")).toBe("generated");
    expect(statusOf("systems")).toBe("generated");
    expect(statusOf("history")).toBe("generated");
    for (const id of [
      "journeys",
      "capabilities",
      "flows",
      "contracts",
      "security",
      "operations",
      "decisions"
    ]) {
      expect(statusOf(id)).toBe("not-written");
    }
  });

  it("gives every chapter a non-empty human title", () => {
    const book = buildBookManifest(makeManifest());
    for (const chapter of book.chapters) {
      expect(chapter.title.length).toBeGreaterThan(0);
    }
  });

  it("mirrors specVersion and repository name from the change manifest", () => {
    const book = buildBookManifest(makeManifest());
    expect(book.specVersion).toBe("0.1.0");
    expect(book.repository.name).toBe("fixture");
  });

  it("validates against the book-manifest schema", () => {
    const result = validateBookManifest(buildBookManifest(makeManifest()));
    expect(result.ok).toBe(true);
  });

  it("degrades systems to not-written when there are no entities", () => {
    const book = buildBookManifest(makeManifest({ entities: [] }));
    expect(book.chapters.find((c) => c.id === "systems")?.status).toBe(
      "not-written"
    );
    expect(validateBookManifest(book).ok).toBe(true);
  });

  it("degrades history to not-written when there are no change units", () => {
    const book = buildBookManifest(makeManifest({ changeUnits: [] }));
    expect(book.chapters.find((c) => c.id === "history")?.status).toBe(
      "not-written"
    );
    expect(validateBookManifest(book).ok).toBe(true);
  });

  it("keeps a hostile repository name inert (no mangling, no escaping here)", () => {
    const book = buildBookManifest(
      makeManifest({ repository: { name: HOSTILE_NAME } })
    );
    expect(book.repository.name).toBe(HOSTILE_NAME);
    // Escaping is the renderer's job; the manifest carries raw data and
    // must survive a JSON round-trip untouched.
    expect(JSON.parse(JSON.stringify(book))).toEqual(book);
    expect(validateBookManifest(book).ok).toBe(true);
  });

  it("does not mutate the input manifest", () => {
    const manifest = makeManifest();
    const snapshot = structuredClone(manifest);
    buildBookManifest(manifest);
    expect(manifest).toEqual(snapshot);
  });

  it("marks narrated chapters and carries their narration into the book", () => {
    const book = buildBookManifest(
      makeManifest({
        chapterNarrations: {
          purpose: {
            summary: "Exists so guests can order.",
            keyPoints: ["Guest checkout"],
            provenance: "inferred"
          },
          systems: { summary: "One route, one store.", provenance: "inferred" },
          flows: { summary: "Intake writes to storage.", provenance: "inferred" }
        }
      })
    );
    const chapterOf = (id: string) => book.chapters.find((c) => c.id === id)!;
    expect(chapterOf("purpose").status).toBe("narrated");
    expect(chapterOf("systems").status).toBe("narrated");
    expect(chapterOf("flows").status).toBe("narrated");
    expect(chapterOf("purpose").narration).toEqual({
      summary: "Exists so guests can order.",
      keyPoints: ["Guest checkout"]
    });
    expect(chapterOf("flows").narration?.summary).toBe(
      "Intake writes to storage."
    );
    // History is untouched by chapter narration.
    expect(chapterOf("history").status).toBe("generated");
    expect(validateBookManifest(book).ok).toBe(true);
  });

  it("keeps unnarrated chapter statuses unchanged when only flows is narrated", () => {
    const book = buildBookManifest(
      makeManifest({
        chapterNarrations: {
          flows: { summary: "Intake writes to storage.", provenance: "inferred" }
        }
      })
    );
    const statusOf = (id: string) =>
      book.chapters.find((c) => c.id === id)?.status;
    expect(statusOf("flows")).toBe("narrated");
    expect(statusOf("purpose")).toBe("generated");
    expect(statusOf("systems")).toBe("generated");
    expect(statusOf("journeys")).toBe("not-written");
    expect(validateBookManifest(book).ok).toBe(true);
  });
});
