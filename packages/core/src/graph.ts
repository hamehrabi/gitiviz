/**
 * Evidence graph builder: deterministic projection of git diffs + analyzer
 * facts into schema Entities and Relationships.
 *
 * Everything here is `provenance: "derived"` — no interpretation, no AI.
 * All labels are verbatim repository data: hostile, kept inert, escaped only
 * at render time.
 *
 * Base/head state semantics (symmetric, per side):
 *   - "added":     exists on this side only
 *   - "removed":   absent on this side (exists on the other)
 *   - "changed":   exists on both sides with differing content
 *   - "unchanged": identical on both sides
 * So an entity introduced by the change is `baseState: "removed",
 * headState: "added"`; one deleted by it is `baseState: "added",
 * headState: "removed"`.
 *
 * Stable ids: `sha1(kind + "\0" + technicalLabel)` truncated to 12 hex chars.
 * Fact-derived labels deliberately exclude the file path (a route is
 * "POST /orders", a symbol is its name), so entities keep their id across
 * file renames. v0.1 crudeness, documented: two same-named exports in
 * different files collapse into one entity.
 *
 * Directory rollup: each changed file gets a parent "system" entity per
 * top-level source directory (`src/routes` → "Routes"). Crude but honest;
 * the narrator may later refine labels as `inferred`.
 */

import { createHash } from "node:crypto";
import type {
  ChangeState,
  Entity,
  EvidenceAnchor,
  Relationship
} from "@gitiviz/schema";
import type { FileChange } from "@gitiviz/git";
import type { AnalyzerFact } from "@gitiviz/analyzers";

export interface GraphInput {
  fileChanges: FileChange[];
  /** Analyzer facts computed from the base-side content of changed files. */
  baseFacts: AnalyzerFact[];
  /** Analyzer facts computed from the head-side content of changed files. */
  headFacts: AnalyzerFact[];
}

export interface EvidenceGraph {
  entities: Entity[];
  relationships: Relationship[];
}

interface SideStates {
  baseState: ChangeState;
  headState: ChangeState;
}

function statesOf(inBase: boolean, inHead: boolean, changed: boolean): SideStates {
  if (inBase && inHead) {
    return changed
      ? { baseState: "changed", headState: "changed" }
      : { baseState: "unchanged", headState: "unchanged" };
  }
  if (inHead) return { baseState: "removed", headState: "added" };
  return { baseState: "added", headState: "removed" };
}

function entityId(kind: string, technicalLabel: string): string {
  return createHash("sha1").update(`${kind}\0${technicalLabel}`).digest("hex").slice(0, 12);
}

function relationshipId(verb: string, from: string, to: string): string {
  return createHash("sha1").update(`rel\0${verb}\0${from}\0${to}`).digest("hex").slice(0, 12);
}

function basename(path: string): string {
  const segments = path.split("/");
  return segments[segments.length - 1] ?? path;
}

/**
 * Rollup key for a file path: up to the first two directory segments
 * (`src/routes/api/orders.ts` → `src/routes`, `lib/x.ts` → `lib`),
 * or "." for repo-root files.
 */
function groupDirOf(path: string): string {
  const segments = path.split("/");
  segments.pop(); // file name
  if (segments.length === 0) return ".";
  return segments.slice(0, 2).join("/");
}

function groupLabelOf(dir: string): string {
  if (dir === ".") return "Project root";
  const last = basename(dir);
  if (last.length === 0) return dir;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

/** Deterministic flat rendering of a fact value, used for content diffing
 * and as a last-resort label for unknown fact shapes. */
function stableValueString(value: Record<string, string>): string {
  return Object.keys(value)
    .sort()
    .map((k) => `${k}=${value[k]}`)
    .join(", ");
}

interface FactIdentity {
  kind: string;
  technicalLabel: string;
}

/**
 * Path-independent identity of a fact (see id stability note above).
 * Never throws: facts with missing fields fall back to a generic identity.
 */
function factIdentityOf(fact: AnalyzerFact): FactIdentity {
  const v = fact.value;
  switch (fact.kind) {
    case "route":
      if (v.method !== undefined && v.path !== undefined) {
        return { kind: "route", technicalLabel: `${v.method} ${v.path}` };
      }
      break;
    case "export":
      if (v.name !== undefined) {
        return { kind: "symbol", technicalLabel: v.name };
      }
      break;
    case "import":
      if (v.source !== undefined) {
        return { kind: "module", technicalLabel: v.source };
      }
      break;
    case "package":
      if (v.name !== undefined) {
        return { kind: "package", technicalLabel: v.name };
      }
      break;
    default:
      break;
  }
  return { kind: fact.kind, technicalLabel: stableValueString(v) || fact.kind };
}

/** Verb for the file → fact-entity relationship, by fact kind. */
function verbFor(fact: AnalyzerFact): string {
  if (fact.kind === "import") return "imports";
  if (fact.kind === "package" && fact.value.role === "dependency") return "depends on";
  return "defines";
}

interface FactBucket {
  identity: FactIdentity;
  base: AnalyzerFact[];
  head: AnalyzerFact[];
}

interface RelationshipBucket {
  verb: string;
  from: string;
  to: string;
  inBase: boolean;
  inHead: boolean;
  evidence: EvidenceAnchor[];
}

export function buildEvidenceGraph(input: GraphInput): EvidenceGraph {
  const entities = new Map<string, Entity>();
  const relationshipBuckets = new Map<string, RelationshipBucket>();

  const addRelationship = (
    verb: string,
    from: string,
    to: string,
    side: { inBase: boolean; inHead: boolean },
    evidence?: EvidenceAnchor
  ): void => {
    const key = `${verb}\0${from}\0${to}`;
    let bucket = relationshipBuckets.get(key);
    if (bucket === undefined) {
      bucket = { verb, from, to, inBase: false, inHead: false, evidence: [] };
      relationshipBuckets.set(key, bucket);
    }
    bucket.inBase ||= side.inBase;
    bucket.inHead ||= side.inHead;
    if (evidence !== undefined) bucket.evidence.push(evidence);
  };

  // ---- File entities -----------------------------------------------------
  // Look up the FileChange for a fact anchor path on either side. Base-side
  // facts of a renamed file anchor at the old path.
  const byBasePath = new Map<string, FileChange>();
  const byHeadPath = new Map<string, FileChange>();
  const fileEntityIds = new Map<FileChange, string>();
  const filePresence = new Map<FileChange, { inBase: boolean; inHead: boolean }>();

  for (const fc of input.fileChanges) {
    const inBase = fc.status !== "added";
    const inHead = fc.status !== "deleted";
    const changed = fc.status === "modified" || fc.status === "renamed";
    if (inBase) byBasePath.set(fc.oldPath ?? fc.path, fc);
    if (inHead) byHeadPath.set(fc.path, fc);

    const id = entityId("file", fc.path);
    fileEntityIds.set(fc, id);
    filePresence.set(fc, { inBase, inHead });

    const evidence: EvidenceAnchor[] = [];
    const basePath = fc.oldPath ?? fc.path;
    if (inBase && basePath !== fc.path) {
      // Renamed: keep both sides' paths as separate anchors.
      const baseAnchor: EvidenceAnchor = { path: basePath };
      if (fc.baseBlob !== undefined) baseAnchor.baseBlob = fc.baseBlob;
      evidence.push(baseAnchor);
      const headAnchor: EvidenceAnchor = { path: fc.path };
      if (fc.headBlob !== undefined) headAnchor.headBlob = fc.headBlob;
      evidence.push(headAnchor);
    } else {
      const anchor: EvidenceAnchor = { path: fc.path };
      if (fc.baseBlob !== undefined) anchor.baseBlob = fc.baseBlob;
      if (fc.headBlob !== undefined) anchor.headBlob = fc.headBlob;
      evidence.push(anchor);
    }

    entities.set(id, {
      id,
      kind: "file",
      humanLabel: basename(fc.path),
      technicalLabel: fc.path,
      ...statesOf(inBase, inHead, changed),
      provenance: "derived",
      evidence
    });
  }

  // ---- Directory rollup ("system" entities) ------------------------------
  const groups = new Map<string, FileChange[]>();
  for (const fc of input.fileChanges) {
    const dir = groupDirOf(fc.path);
    const members = groups.get(dir);
    if (members === undefined) groups.set(dir, [fc]);
    else members.push(fc);
  }

  for (const [dir, members] of groups) {
    const inBase = members.some((fc) => filePresence.get(fc)!.inBase);
    const inHead = members.some((fc) => filePresence.get(fc)!.inHead);
    const id = entityId("system", dir);
    entities.set(id, {
      id,
      kind: "system",
      humanLabel: groupLabelOf(dir),
      technicalLabel: dir,
      // Every member is by definition a change, so a group present on both
      // sides is "changed".
      ...statesOf(inBase, inHead, true),
      provenance: "derived",
      evidence: [{ path: dir }]
    });
    for (const fc of members) {
      const presence = filePresence.get(fc)!;
      addRelationship("contains", id, fileEntityIds.get(fc)!, presence, {
        path: fc.path
      });
    }
  }

  // ---- Fact entities (routes, symbols, modules, packages, …) -------------
  const buckets = new Map<string, FactBucket>();
  const bucketOf = (fact: AnalyzerFact): FactBucket => {
    const identity = factIdentityOf(fact);
    const key = `${identity.kind}\0${identity.technicalLabel}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { identity, base: [], head: [] };
      buckets.set(key, bucket);
    }
    return bucket;
  };
  for (const fact of input.baseFacts) bucketOf(fact).base.push(fact);
  for (const fact of input.headFacts) bucketOf(fact).head.push(fact);

  for (const bucket of buckets.values()) {
    const { kind, technicalLabel } = bucket.identity;
    const inBase = bucket.base.length > 0;
    const inHead = bucket.head.length > 0;
    const contentOf = (facts: AnalyzerFact[]): string =>
      facts
        .map((f) => stableValueString(f.value))
        .sort()
        .join("\n");
    const changed = inBase && inHead && contentOf(bucket.base) !== contentOf(bucket.head);

    const id = entityId(kind, technicalLabel);
    const evidence: EvidenceAnchor[] = [];
    const anchorFor = (fact: AnalyzerFact, side: "base" | "head"): EvidenceAnchor => {
      const anchor: EvidenceAnchor = {
        path: fact.anchor.path,
        range: { startLine: fact.anchor.startLine, endLine: fact.anchor.endLine }
      };
      const fc =
        side === "base" ? byBasePath.get(fact.anchor.path) : byHeadPath.get(fact.anchor.path);
      if (fc !== undefined) {
        if (side === "base" && fc.baseBlob !== undefined) anchor.baseBlob = fc.baseBlob;
        if (side === "head" && fc.headBlob !== undefined) anchor.headBlob = fc.headBlob;
      }
      return anchor;
    };
    for (const fact of bucket.base) evidence.push(anchorFor(fact, "base"));
    for (const fact of bucket.head) evidence.push(anchorFor(fact, "head"));
    evidence.sort((a, b) =>
      a.path !== b.path
        ? a.path < b.path
          ? -1
          : 1
        : (a.range?.startLine ?? 0) - (b.range?.startLine ?? 0)
    );

    entities.set(id, {
      id,
      kind,
      humanLabel: technicalLabel,
      technicalLabel,
      ...statesOf(inBase, inHead, changed),
      provenance: "derived",
      evidence
    });

    // File → fact relationships ("defines" / "imports" / "depends on").
    const link = (fact: AnalyzerFact, side: "base" | "head"): void => {
      const fc =
        side === "base" ? byBasePath.get(fact.anchor.path) : byHeadPath.get(fact.anchor.path);
      if (fc === undefined) return; // orphan fact: entity kept, link skipped
      addRelationship(
        verbFor(fact),
        fileEntityIds.get(fc)!,
        id,
        { inBase: side === "base", inHead: side === "head" },
        anchorFor(fact, side)
      );
    };
    for (const fact of bucket.base) link(fact, "base");
    for (const fact of bucket.head) link(fact, "head");
  }

  // ---- Deterministic ordering -------------------------------------------
  const entityList = [...entities.values()].sort((a, b) =>
    a.kind !== b.kind
      ? a.kind < b.kind
        ? -1
        : 1
      : (a.technicalLabel ?? "") < (b.technicalLabel ?? "")
        ? -1
        : (a.technicalLabel ?? "") > (b.technicalLabel ?? "")
          ? 1
          : 0
  );

  const relationshipList = [...relationshipBuckets.values()]
    .map((bucket): Relationship => {
      const rel: Relationship = {
        id: relationshipId(bucket.verb, bucket.from, bucket.to),
        from: bucket.from,
        to: bucket.to,
        verb: bucket.verb,
        // Relationships are presence-only in v0.1: no content to diff.
        ...statesOf(bucket.inBase, bucket.inHead, false),
        provenance: "derived"
      };
      if (bucket.evidence.length > 0) {
        rel.evidence = [...bucket.evidence].sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : (a.range?.startLine ?? 0) - (b.range?.startLine ?? 0)
        );
      }
      return rel;
    })
    .sort((a, b) =>
      a.verb !== b.verb
        ? a.verb < b.verb
          ? -1
          : 1
        : a.from !== b.from
          ? a.from < b.from
            ? -1
            : 1
          : a.to < b.to
            ? -1
            : a.to > b.to
              ? 1
              : 0
    );

  return { entities: entityList, relationships: relationshipList };
}
