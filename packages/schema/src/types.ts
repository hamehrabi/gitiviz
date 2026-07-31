/**
 * Core Gitiviz data model.
 *
 * Every claim carries provenance:
 *   - "declared": stated by a human
 *   - "derived":  produced deterministically by analysis (✓)
 *   - "inferred": produced by AI interpretation (◇) — the only provenance
 *                 allowed to carry a confidence value
 *   - "unknown":  origin cannot be established
 *
 * The JSON Schema mirror (spec/change-manifest.schema.json) enforces that
 * provenance is required and that `confidence` is forbidden unless
 * provenance === "inferred".
 */

export type Provenance = "declared" | "derived" | "inferred" | "unknown";

export type ChangeState = "added" | "changed" | "removed" | "unchanged";

export interface SourceRange {
  startLine: number;
  endLine: number;
}

/**
 * Where a claim's evidence lives in the repository. Blob hashes keep
 * anchors valid as branches move.
 */
export interface EvidenceAnchor {
  /** Repo-relative path (hostile input — escape before any HTML output). */
  path: string;
  baseBlob?: string;
  headBlob?: string;
  range?: SourceRange;
  symbol?: string;
  fingerprint?: string;
}

/** Fields shared by every claim-carrying record. */
export interface Claim {
  provenance: Provenance;
  /** Only meaningful (and only permitted) when provenance === "inferred". */
  confidence?: number;
  evidence?: EvidenceAnchor[];
}

/** A thing in the system: person, system, service, route, table, module… */
export interface Entity extends Claim {
  id: string;
  kind: string;
  humanLabel: string;
  technicalLabel?: string;
  baseState: ChangeState;
  headState: ChangeState;
}

/** An arrow with a verb. The verb is mandatory by schema. */
export interface Relationship extends Claim {
  id: string;
  from: string;
  to: string;
  verb: string;
  kind?: string;
  baseState: ChangeState;
  headState: ChangeState;
}

/**
 * One meaningful change grouping many diff hunks. Technical fields are
 * derived; the null-able narration slots are filled by the (validated)
 * narrator and stamped "inferred".
 */
export interface ChangeUnit extends Claim {
  id: string;
  technicalTitle: string;
  humanTitle?: string | null;
  type?: string;
  commits?: string[];
  entities?: string[];
  relationships?: string[];
  /** True for fixup/squash/merge/whitespace-only commits kept in the timeline only. */
  grouped?: boolean;
  groupedReason?: string;
  summary?: string | null;
  beforeDescription?: string | null;
  afterDescription?: string | null;
  userImpact?: string | null;
  openQuestions?: string[];
}

/** Honest record of what analysis could not (or chose not to) do. */
export interface AnalysisLimitation {
  message: string;
  path?: string;
  analyzer?: string;
}

export interface ChangeManifest {
  /** Semver; this validator understands major version 0 only. */
  specVersion: string;
  repository: {
    name: string;
  };
  /** 40-char commit sha. */
  baseRevision: string;
  /** 40-char commit sha, or "WORKTREE" for dirty-working-tree comparisons. */
  headRevision: string;
  entities: Entity[];
  relationships: Relationship[];
  changeUnits: ChangeUnit[];
  analysisLimitations: AnalysisLimitation[];
}

/** The ten canonical book chapters, in reading order. */
export const CHAPTER_IDS = [
  "purpose",
  "journeys",
  "systems",
  "capabilities",
  "flows",
  "contracts",
  "security",
  "operations",
  "decisions",
  "history"
] as const;

export type ChapterId = (typeof CHAPTER_IDS)[number];

export type ChapterStatus = "generated" | "curated" | "not-written";

export interface BookChapter {
  id: ChapterId;
  title: string;
  status: ChapterStatus;
}

export interface BookManifest {
  specVersion: string;
  repository: {
    name: string;
  };
  chapters: BookChapter[];
}
