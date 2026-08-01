/**
 * Book skeleton projection.
 *
 * v0.1 generates three chapters from the change manifest:
 *   - "purpose"  — package metadata (repository name) + top-level entities
 *   - "systems"  — the grouped architecture (entities + relationships)
 *   - "history"  — the commit timeline (change units, grouped ones included)
 * The other seven chapters exist in the skeleton but are honestly marked
 * "not-written" — they render as "not yet written", never as empty prose.
 *
 * A chapter is only marked "generated" when the data it would be generated
 * from actually exists: no entities → no systems chapter, no change units →
 * no history chapter. Repo-derived strings (repository name) are hostile
 * data and pass through inert — escaping happens only at render time.
 */
import type {
  BookChapter,
  BookManifest,
  ChangeManifest,
  ChapterId,
  ChapterStatus,
  NarratedChapterId
} from "@gitiviz/schema";
import { CHAPTER_IDS, NARRATED_CHAPTER_IDS } from "@gitiviz/schema";

/** Reader-facing chapter titles, keyed by canonical chapter id. */
const CHAPTER_TITLES: Record<ChapterId, string> = {
  purpose: "Why this exists",
  journeys: "User journeys",
  systems: "The systems at a glance",
  capabilities: "What it can do",
  flows: "How it runs",
  contracts: "Contracts and interfaces",
  security: "Security",
  operations: "Running it",
  decisions: "Decisions",
  history: "How it got here"
};

/** Validated chapter narration for this chapter, if the narrator wrote one. */
function narrationFor(id: ChapterId, manifest: ChangeManifest) {
  if (!(NARRATED_CHAPTER_IDS as readonly string[]).includes(id)) return undefined;
  return manifest.chapterNarrations?.[id as NarratedChapterId];
}

/** Status for one chapter given the change manifest it would draw from. */
function chapterStatus(id: ChapterId, manifest: ChangeManifest): ChapterStatus {
  // A validated (AI-)narrated chapter outranks the deterministic statuses —
  // the narration only exists because applyNarration accepted it.
  if (narrationFor(id, manifest) !== undefined) return "narrated";
  switch (id) {
    case "purpose":
      // Package metadata (repository name) is always present in a valid
      // manifest, so the purpose chapter can always be generated.
      return "generated";
    case "systems":
      return manifest.entities.length > 0 ? "generated" : "not-written";
    case "history":
      return manifest.changeUnits.length > 0 ? "generated" : "not-written";
    default:
      return "not-written";
  }
}

/**
 * Project a ChangeManifest into the ten-chapter book skeleton. Pure and
 * deterministic; never mutates its input.
 */
export function buildBookManifest(manifest: ChangeManifest): BookManifest {
  return {
    specVersion: manifest.specVersion,
    repository: { name: manifest.repository.name },
    chapters: CHAPTER_IDS.map((id) => {
      const chapter: BookChapter = {
        id,
        title: CHAPTER_TITLES[id],
        status: chapterStatus(id, manifest)
      };
      const narration = narrationFor(id, manifest);
      if (narration !== undefined) {
        chapter.narration = { summary: narration.summary };
        if (narration.keyPoints !== undefined) {
          chapter.narration.keyPoints = [...narration.keyPoints];
        }
      }
      return chapter;
    })
  };
}
