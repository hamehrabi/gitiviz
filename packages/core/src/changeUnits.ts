/**
 * Change-unit grouping + commit classification.
 *
 * v0.1 rule: one ChangeUnit per commit in base..head, oldest first. Commits
 * that carry no independent meaning are flagged `grouped: true` with a
 * reason — they stay in the timeline but don't get their own chapter:
 *   - message subject starts with "fixup!" or "squash!"
 *   - merge commits (more than one parent)
 *   - whitespace-only diffs (`git diff -w` against the first parent is empty)
 *
 * Everything produced here is `provenance: "derived"`: technical titles are
 * verbatim commit subjects (hostile data — escaped only at render time);
 * human titles stay null for the narrator to fill in (as "inferred").
 *
 * Non-grouped units additionally persist the commit's touched paths (old and
 * new sides of renames) as sorted evidence anchors — the renderer's Sources
 * list links to them. Capped at MAX_EVIDENCE_PATHS with an honest
 * analysisLimitation on truncation; grouped units carry no evidence.
 *
 * Classification failures never crash the build: the affected commit keeps a
 * conservative ungrouped unit and the failure is recorded in
 * analysisLimitations.
 */
import { createHash } from "node:crypto";
import type { AnalysisLimitation, ChangeUnit, Entity } from "@gitiviz/schema";
import { WORKTREE, gitRaw, parseNameStatusZ, resolveRef } from "@gitiviz/git";

/** sha of git's canonical empty tree: first-parent base for root commits. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Defensive cap on stored subject length (hostile repo data). */
const MAX_SUBJECT_LENGTH = 2000;

/** Cap on touched paths persisted as a unit's evidence (huge commits). */
const MAX_EVIDENCE_PATHS = 500;

/**
 * How far back `knownChangeUnitIds` reads. Bounded so the scan stays cheap on
 * repositories with very long histories — beyond this a curated story simply
 * counts as unverifiable and is treated exactly as it is today (rejected).
 */
const MAX_KNOWN_COMMITS = 2000;

export interface ChangeUnitsInput {
  repoDir: string;
  baseRef: string;
  /** A commit-ish, or WORKTREE ("compare against the working tree"). */
  headRef: string;
  /**
   * Evidence-graph entities for the same range. Each unit lists the ids of
   * entities whose evidence anchors sit on a path the commit touched.
   */
  entities?: Entity[];
}

export interface ChangeUnitsResult {
  changeUnits: ChangeUnit[];
  analysisLimitations: AnalysisLimitation[];
}

interface CommitMeta {
  sha: string;
  parents: string[];
  subject: string;
}

/**
 * A change unit's id, derived deterministically from its commit sha.
 *
 * Exported because the derivation is the ONLY thing that makes a unit id
 * verifiable: given the repository's history, any id can be checked against
 * the commits that really exist (see `knownChangeUnitIds`). Never duplicate
 * this hash — an out-of-sync copy would silently split ids in two.
 */
export function unitId(sha: string): string {
  return createHash("sha1").update(`change-unit\0${sha}`).digest("hex").slice(0, 12);
}

/**
 * Ids of every change unit this repository could legitimately produce: one per
 * commit reachable from any ref (plus HEAD), newest-first and bounded at
 * MAX_KNOWN_COMMITS.
 *
 * This is the membership test that separates "a curated story about another
 * commit" from "a fabricated id". It is deliberately generous about WHICH
 * commit — the accumulating narration response legitimately describes commits
 * outside whatever range is being rendered, on this branch or another — and
 * deliberately strict about whether the commit exists at all: an id that no
 * real commit hashes to cannot have come from any gitiviz run against this
 * repository.
 *
 * Throws like any other git call when the directory is not a usable
 * repository; callers must treat that as "cannot verify" and stay strict.
 */
export async function knownChangeUnitIds(repoDir: string): Promise<Set<string>> {
  const { stdout } = await gitRaw(repoDir, [
    "log",
    "--all",
    `--max-count=${MAX_KNOWN_COMMITS}`,
    "--format=%H"
  ]);
  const ids = new Set<string>();
  for (const line of stdout.split("\n")) {
    const sha = line.trim();
    if (sha.length > 0) ids.add(unitId(sha));
  }
  return ids;
}

/**
 * Parse `git log --format=%H%x00%P%x00%s` output. %s folds the subject onto
 * one line, so records are newline-separated and NUL-split within.
 */
function parseLog(stdout: string): CommitMeta[] {
  const commits: CommitMeta[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const [sha, parents, ...subjectParts] = line.split("\0");
    if (sha === undefined || parents === undefined) continue;
    commits.push({
      sha,
      parents: parents.length === 0 ? [] : parents.split(" "),
      // A subject containing NUL cannot occur in a valid commit; rejoin
      // defensively rather than drop data.
      subject: subjectParts.join("\0").slice(0, MAX_SUBJECT_LENGTH)
    });
  }
  return commits;
}

/** Grouping reason for a commit, or null when it is meaningful on its own. */
async function classify(
  repoDir: string,
  commit: CommitMeta
): Promise<string | null> {
  if (commit.subject.startsWith("fixup!")) {
    return "fixup! commit: amends an earlier commit in this range";
  }
  if (commit.subject.startsWith("squash!")) {
    return "squash! commit: amends an earlier commit in this range";
  }
  if (commit.parents.length > 1) {
    return "merge commit: brings in changes already told elsewhere";
  }
  const parent = commit.parents[0] ?? EMPTY_TREE;
  const { stdout } = await gitRaw(repoDir, [
    "diff",
    "-w",
    "--end-of-options",
    parent,
    commit.sha
  ]);
  if (stdout.trim().length === 0) {
    return "whitespace-only change (git diff -w is empty)";
  }
  return null;
}

/** Paths (old and new sides) touched by a commit vs its first parent. */
async function touchedPaths(
  repoDir: string,
  commit: CommitMeta
): Promise<Set<string>> {
  const parent = commit.parents[0] ?? EMPTY_TREE;
  const { stdout } = await gitRaw(repoDir, [
    "diff",
    "--name-status",
    "-z",
    "-M",
    "--end-of-options",
    parent,
    commit.sha
  ]);
  const paths = new Set<string>();
  for (const record of parseNameStatusZ(stdout)) {
    paths.add(record.path);
    if (record.oldPath !== undefined) paths.add(record.oldPath);
  }
  return paths;
}

/** Ids of entities with an evidence anchor on any touched path, sorted. */
function attachedEntityIds(entities: Entity[], paths: Set<string>): string[] {
  const ids: string[] = [];
  for (const entity of entities) {
    if (entity.evidence?.some((anchor) => paths.has(anchor.path))) {
      ids.push(entity.id);
    }
  }
  return ids.sort();
}

/**
 * One ChangeUnit per commit in baseRef..headRef, oldest first, classified
 * per the rules above. Never throws for per-commit analysis failures (they
 * become analysisLimitations); unknown refs still throw a clear error.
 */
export async function buildChangeUnits(
  input: ChangeUnitsInput
): Promise<ChangeUnitsResult> {
  const { repoDir, entities = [] } = input;
  const limitations: AnalysisLimitation[] = [];

  const baseSha = await resolveRef(repoDir, input.baseRef);
  const headSha = await resolveRef(
    repoDir,
    input.headRef === WORKTREE ? "HEAD" : input.headRef
  );
  if (input.headRef === WORKTREE) {
    limitations.push({
      message:
        "Uncommitted working-tree changes belong to no commit and are not part of any change unit."
    });
  }

  const { stdout } = await gitRaw(repoDir, [
    "log",
    "--reverse",
    "--format=%H%x00%P%x00%s",
    `${baseSha}..${headSha}`
  ]);

  const changeUnits: ChangeUnit[] = [];
  for (const commit of parseLog(stdout)) {
    const unit: ChangeUnit = {
      id: unitId(commit.sha),
      technicalTitle: commit.subject.length > 0 ? commit.subject : commit.sha.slice(0, 12),
      humanTitle: null,
      type: "commit",
      commits: [commit.sha],
      entities: [],
      provenance: "derived"
    };

    try {
      const reason = await classify(repoDir, commit);
      if (reason !== null) {
        unit.grouped = true;
        unit.groupedReason = reason;
      }
    } catch (error) {
      limitations.push({
        message:
          `Could not classify commit ${commit.sha}: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          "Treating it as a meaningful change."
      });
    }

    // Touched paths feed two derived facts: entity attachment (all units)
    // and the persisted evidence anchors (non-grouped units only — grouped
    // commits have no chapter for a Sources list to live on).
    const wantsEvidence = unit.grouped !== true;
    if (wantsEvidence || entities.length > 0) {
      try {
        const paths = await touchedPaths(repoDir, commit);
        if (entities.length > 0) {
          unit.entities = attachedEntityIds(entities, paths);
        }
        if (wantsEvidence && paths.size > 0) {
          const sorted = [...paths].sort();
          if (sorted.length > MAX_EVIDENCE_PATHS) {
            limitations.push({
              message:
                `Commit ${commit.sha} touched ${sorted.length} paths; only the ` +
                `first ${MAX_EVIDENCE_PATHS} (sorted) are recorded as its ` +
                "change unit's evidence."
            });
          }
          unit.evidence = sorted
            .slice(0, MAX_EVIDENCE_PATHS)
            .map((path) => ({ path }));
        }
      } catch (error) {
        limitations.push({
          message:
            `Could not list files touched by commit ${commit.sha}: ` +
            `${error instanceof Error ? error.message : String(error)}. ` +
            "No entities attached to its change unit and no evidence paths recorded."
        });
      }
    }

    changeUnits.push(unit);
  }

  return { changeUnits, analysisLimitations: limitations };
}
