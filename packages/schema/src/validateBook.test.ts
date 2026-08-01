import { describe, it, expect } from "vitest";
import { validateBookManifest } from "./validate.js";
import { CHAPTER_IDS } from "./types.js";

const skeleton = () => ({
  specVersion: "0.1.0",
  repository: { name: "fixture" },
  chapters: CHAPTER_IDS.map((id) => ({
    id,
    title: id[0].toUpperCase() + id.slice(1),
    status: "not-written"
  }))
});

describe("book manifest validation", () => {
  it("accepts a valid ten-chapter skeleton", () => {
    expect(validateBookManifest(skeleton()).ok).toBe(true);
  });

  it("accepts all four chapter statuses", () => {
    const m = skeleton();
    m.chapters[0].status = "generated";
    m.chapters[1].status = "curated";
    m.chapters[2].status = "narrated";
    expect(validateBookManifest(m).ok).toBe(true);
  });

  it("accepts a narrated chapter carrying narration with up to 5 keyPoints", () => {
    const m = skeleton();
    m.chapters[0].status = "narrated";
    (m.chapters[0] as Record<string, unknown>).narration = {
      summary: "Why it exists.",
      keyPoints: ["1", "2", "3", "4", "5"]
    };
    expect(validateBookManifest(m).ok).toBe(true);
  });

  it("rejects chapter narration with more than 5 keyPoints or no summary", () => {
    const over = skeleton();
    (over.chapters[0] as Record<string, unknown>).narration = {
      summary: "ok",
      keyPoints: ["1", "2", "3", "4", "5", "6"]
    };
    expect(validateBookManifest(over).ok).toBe(false);
    const missing = skeleton();
    (missing.chapters[0] as Record<string, unknown>).narration = {
      keyPoints: ["no summary"]
    };
    expect(validateBookManifest(missing).ok).toBe(false);
  });

  it("rejects when a chapter id is missing", () => {
    const m = skeleton();
    m.chapters = m.chapters.filter((c) => c.id !== "security");
    expect(validateBookManifest(m).ok).toBe(false);
  });

  it("rejects a duplicate chapter id replacing a canonical one", () => {
    const m = skeleton();
    // Ten chapters, but "history" appears twice and "purpose" is gone.
    m.chapters[0] = { ...m.chapters[9] };
    expect(validateBookManifest(m).ok).toBe(false);
  });

  it("rejects a non-canonical chapter id", () => {
    const m = skeleton();
    (m.chapters as unknown[]).push({
      id: "appendix",
      title: "Appendix",
      status: "not-written"
    });
    expect(validateBookManifest(m).ok).toBe(false);
  });

  it("rejects an invalid chapter status", () => {
    const m = skeleton();
    (m.chapters[0] as { status: string }).status = "done";
    expect(validateBookManifest(m).ok).toBe(false);
  });

  it("rejects unknown specVersion major", () => {
    const m = { ...skeleton(), specVersion: "9.0.0" };
    expect(validateBookManifest(m).ok).toBe(false);
  });
});
