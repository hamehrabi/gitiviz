/**
 * Shared view-model types for the dashboard reader experience
 * (docs/plans/2026-07-31-gitiviz-design.md, "Reader experience").
 *
 * These types are the ONLY coupling between the three parallel modules
 * (sidebar.ts, cards.ts, commitPage.ts). They are derived projections of
 * the manifest types in @gitiviz/schema — renderers never reach back into
 * the manifest except through the mapping helpers here.
 *
 * All string fields that originate in the repository are HOSTILE INPUT and
 * must pass through escape.ts (escHtml / escAttr) at the point of output.
 */

import type { ChangeManifest, ChangeUnit, ChapterId } from "@gitiviz/schema";
import { commitType, type CommitType } from "./render.js";

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

/** One entry in the left sidebar (or the collapsed top tab row). */
export interface ViewTab {
  /** Stable slug from a closed set — safe in ids/class names ("home", "overview", …). */
  id: string;
  /** Reader-facing label ("Home", "How it works", …). Trusted (authored), still escaped. */
  label: string;
  /** Fragment href the tab navigates to, e.g. "#home". */
  href: string;
}

// ---------------------------------------------------------------------------
// Home: commit cards grid
// ---------------------------------------------------------------------------

/** A chapter chip shown on a card ("Systems", "Flows", "Contracts"). */
export interface CardChip {
  id: ChapterId;
  label: string;
}

/** View model for one commit card on the Home grid. */
export interface CardModel {
  /** ChangeUnit id (repo-derived — escape on output). */
  unitId: string;
  /** Fragment href of the commit's own page, e.g. "#u0". */
  href: string;
  /** humanTitle when narrated, technicalTitle fallback (hostile — escape). */
  title: string;
  /** True when the title is AI-narrated → render the ◇ provenance mark. */
  titleInferred: boolean;
  /** One-line narrated summary, or null when not narrated (hostile — escape). */
  summary: string | null;
  /** First commit's 7-char short sha, or null (hostile — escape). */
  shortSha: string | null;
  /** Closed set — safe in class names (cd-type-feature etc.). */
  type: CommitType;
  /** Affected-chapter chips, possibly empty. */
  chapters: CardChip[];
}

// ---------------------------------------------------------------------------
// Commit page (anchor + :target)
// ---------------------------------------------------------------------------

/** View model for one commit's own page. */
export interface CommitPageModel {
  /** Element id targeted by :target — same value the card href points at, without "#". */
  anchorId: string;
  /** humanTitle when narrated, technicalTitle fallback (hostile — escape). */
  title: string;
  titleInferred: boolean;
  /** One-sentence purpose (userImpact ?? summary), null when not narrated. */
  purpose: string | null;
  /** Before / After labeled rows; null renders a quiet placeholder row. */
  before: string | null;
  after: string | null;
  shortSha: string | null;
  type: CommitType;
  /** Count for the collapsed "Unchanged: N" line. */
  unchangedCount: number;
  /** Full unit for the collapsed technical-evidence fold (anchors, entities). */
  unit: ChangeUnit;
}

// ---------------------------------------------------------------------------
// Mapping helpers (the single place manifest → view model happens)
// ---------------------------------------------------------------------------

/** Chip labels for the chapters a change unit can affect. */
export const CARD_CHIP_LABELS: Partial<Record<ChapterId, string>> = {
  systems: "Systems",
  flows: "Flows",
  contracts: "Contracts"
};

/** Deterministic element id for unit at `index` ("u0", "u1", …). */
export function unitAnchorId(index: number): string {
  return `u${index}`;
}

function affectedChapterChips(
  unit: ChangeUnit,
  manifest: ChangeManifest
): CardChip[] {
  const out: CardChip[] = [];
  const entityIds = new Set(unit.entities ?? []);
  const touched = manifest.entities.filter((entity) => entityIds.has(entity.id));
  if (touched.length > 0) out.push({ id: "systems", label: CARD_CHIP_LABELS.systems! });
  if ((unit.relationships ?? []).length > 0) {
    out.push({ id: "flows", label: CARD_CHIP_LABELS.flows! });
  }
  if (touched.some((e) => e.kind === "route" || e.kind === "contract")) {
    out.push({ id: "contracts", label: CARD_CHIP_LABELS.contracts! });
  }
  return out;
}

/**
 * Map one change unit (at its stable index within manifest.changeUnits)
 * to the card view model. Pure and deterministic.
 */
export function toCardModel(
  unit: ChangeUnit,
  index: number,
  manifest: ChangeManifest
): CardModel {
  const sha = unit.commits?.[0];
  return {
    unitId: unit.id,
    href: `#${unitAnchorId(index)}`,
    title: unit.humanTitle ?? unit.technicalTitle,
    titleInferred: unit.provenance === "inferred" && unit.humanTitle != null,
    summary: unit.summary ?? null,
    shortSha: sha ? sha.slice(0, 7) : null,
    type: commitType(unit.technicalTitle),
    chapters: affectedChapterChips(unit, manifest)
  };
}

/**
 * Map one change unit to its commit-page view model. Pure and deterministic.
 * `unchangedCount` = entities in the manifest whose head state is "unchanged"
 * (the quiet "what stayed the same" line).
 */
export function toCommitPageModel(
  unit: ChangeUnit,
  index: number,
  manifest: ChangeManifest
): CommitPageModel {
  const card = toCardModel(unit, index, manifest);
  return {
    anchorId: unitAnchorId(index),
    title: card.title,
    titleInferred: card.titleInferred,
    purpose: unit.userImpact ?? unit.summary ?? null,
    before: unit.beforeDescription ?? null,
    after: unit.afterDescription ?? null,
    shortSha: card.shortSha,
    type: card.type,
    unchangedCount: manifest.entities.filter(
      (e) => e.headState === "unchanged"
    ).length,
    unit
  };
}
