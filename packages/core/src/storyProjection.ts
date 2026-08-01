/**
 * Story projection: rolls the fine-grained evidence graph up to the level a
 * reader thinks at. Changed file/module/symbol/etc. entities are NEVER shown
 * directly — each is attributed to its parent system/component node, and the
 * story is capped at MAX_STORY_NODES nodes (the least-changed areas collapse
 * into a single "…and N more areas" node).
 *
 * Ownership resolution (deterministic):
 *   1. direct: a container's "contains" relationship claims the target;
 *   2. transitive: a leaf pointed at by an owned entity (file defines symbol,
 *      file imports module) inherits that entity's owner — "defines" wins
 *      over other verbs, remaining ties break on owner id then rel id.
 * Changed leaves with no resolvable owner land in an "Other changes" bucket.
 *
 * Edges only appear for CHANGED relationships whose endpoints resolve to two
 * different surviving nodes, with verbs rewritten to plain English
 * ("imports" + added → "now uses"). Everything is sorted, so identical input
 * sets produce identical stories regardless of input order.
 *
 * All labels are verbatim repository data: hostile, kept inert here, escaped
 * only at render time.
 */
import type { ChangeState, ChangeUnit, Entity, Relationship } from "@gitiviz/schema";

/** Hard cap on nodes in any story diagram (user-mandated visual bar). */
export const MAX_STORY_NODES = 7;

/** Entity kinds that may surface as story nodes; everything else rolls up. */
const CONTAINER_KINDS = new Set(["system", "component"]);

const OTHER_NODE_ID = "story:other";
const OVERFLOW_NODE_ID = "story:overflow";

export interface StoryNode {
  id: string;
  /** "system" | "component" for real containers; "other" | "overflow" for buckets. */
  kind: string;
  /** Verbatim (hostile) container label, or the bucket label. */
  humanLabel: string;
  /** Dominant change state across the rolled-up leaves. */
  changeState: ChangeState;
  /** Number of changed leaf entities rolled into this node. */
  count: number;
}

export interface StoryEdge {
  from: string;
  to: string;
  /** Plain-English verb, e.g. "now uses". */
  verb: string;
}

export interface StoryProjection {
  nodes: StoryNode[];
  edges: StoryEdge[];
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function isContainer(entity: Entity): boolean {
  return CONTAINER_KINDS.has(entity.kind);
}

function isChanged(state: ChangeState): boolean {
  return state !== "unchanged";
}

/**
 * Resolve, for every entity id, the id of the container that owns it (or
 * undefined). Deterministic: candidate order never depends on input order.
 */
function resolveOwners(
  entities: readonly Entity[],
  relationships: readonly Relationship[]
): Map<string, string> {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const owner = new Map<string, string>();

  // Pass 1 — direct containment. Smallest container id wins ties.
  const direct = [...relationships]
    .filter((r) => {
      const from = byId.get(r.from);
      return r.verb === "contains" && from !== undefined && isContainer(from);
    })
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  for (const r of direct) {
    if (!owner.has(r.to)) owner.set(r.to, r.from);
  }

  // Pass 2 — inherit through incoming relationships (file → symbol/module),
  // iterated to a fixed point so chains resolve. "defines" outranks other
  // verbs; remaining ties break on owner id, then relationship id.
  const incoming = new Map<string, Relationship[]>();
  for (const r of relationships) {
    if (r.verb === "contains") continue;
    const bucket = incoming.get(r.to);
    if (bucket) bucket.push(r);
    else incoming.set(r.to, [r]);
  }
  for (;;) {
    let progressed = false;
    for (const e of entities) {
      if (owner.has(e.id) || isContainer(e)) continue;
      const candidates = (incoming.get(e.id) ?? [])
        .filter((r) => owner.has(r.from))
        .sort((a, b) => {
          const rankA = a.verb === "defines" ? 0 : 1;
          const rankB = b.verb === "defines" ? 0 : 1;
          if (rankA !== rankB) return rankA - rankB;
          const ownA = owner.get(a.from)!;
          const ownB = owner.get(b.from)!;
          if (ownA !== ownB) return ownA < ownB ? -1 : 1;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
      if (candidates.length > 0) {
        owner.set(e.id, owner.get(candidates[0]!.from)!);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return owner;
}

const STATE_TIE_ORDER: ChangeState[] = ["added", "changed", "removed"];

/** Most frequent state; ties break added > changed > removed. */
function dominantState(states: readonly ChangeState[]): ChangeState {
  const counts = new Map<ChangeState, number>();
  for (const s of states) counts.set(s, (counts.get(s) ?? 0) + 1);
  let best: ChangeState = "changed";
  let bestCount = -1;
  for (const s of STATE_TIE_ORDER) {
    const c = counts.get(s) ?? 0;
    if (c > bestCount) {
      best = s;
      bestCount = c;
    }
  }
  return best;
}

/** Rewrite a graph verb + change state into a plain-English story verb. */
function plainVerb(verb: string, state: ChangeState): string {
  const base = verb === "imports" || verb === "depends on" ? "uses" : verb;
  if (state === "added") return `now ${base}`;
  if (state === "removed") return `no longer ${base}`;
  return base;
}

function project(
  entities: readonly Entity[],
  relationships: readonly Relationship[],
  keepLeaf: (id: string) => boolean,
  keepRelationship: (r: Relationship) => boolean
): StoryProjection {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const owner = resolveOwners(entities, relationships);

  // ---- Roll changed leaves up into their owning container ----------------
  const buckets = new Map<string, ChangeState[]>();
  for (const e of entities) {
    if (isContainer(e) || !isChanged(e.headState) || !keepLeaf(e.id)) continue;
    const key = owner.get(e.id) ?? OTHER_NODE_ID;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(e.headState);
    else buckets.set(key, [e.headState]);
  }

  let nodes: StoryNode[] = [...buckets.entries()].map(([key, states]) => {
    const container = byId.get(key);
    return {
      id: key,
      kind: container?.kind ?? "other",
      humanLabel: container?.humanLabel ?? "Other changes",
      changeState: dominantState(states),
      count: states.length
    };
  });
  nodes.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    if (a.humanLabel !== b.humanLabel) return a.humanLabel < b.humanLabel ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // ---- Cap: fold the least-changed areas into one overflow node ----------
  if (nodes.length > MAX_STORY_NODES) {
    const kept = nodes.slice(0, MAX_STORY_NODES - 1);
    const folded = nodes.slice(MAX_STORY_NODES - 1);
    const foldedStates = folded.flatMap((n) => buckets.get(n.id) ?? []);
    kept.push({
      id: OVERFLOW_NODE_ID,
      kind: "overflow",
      humanLabel: `…and ${folded.length} more areas`,
      changeState: dominantState(foldedStates),
      count: folded.reduce((sum, n) => sum + n.count, 0)
    });
    nodes = kept;
  }
  const nodeIds = new Set(nodes.map((n) => n.id));

  /** Map an entity id to the surviving story node it belongs to, if any. */
  const nodeOf = (entityId: string): string | undefined => {
    const e = byId.get(entityId);
    if (e === undefined) return undefined;
    const key = isContainer(e) ? e.id : (owner.get(e.id) ?? OTHER_NODE_ID);
    return nodeIds.has(key) ? key : undefined;
  };

  // ---- Edges: changed cross-node relationships, plain verbs --------------
  const seen = new Set<string>();
  const edges: StoryEdge[] = [];
  for (const r of relationships) {
    if (r.verb === "contains" || !isChanged(r.headState) || !keepRelationship(r)) continue;
    const from = nodeOf(r.from);
    const to = nodeOf(r.to);
    if (from === undefined || to === undefined || from === to) continue;
    const verb = plainVerb(r.verb, r.headState);
    const key = `${from}\0${to}\0${verb}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to, verb });
  }
  edges.sort((a, b) => {
    if (a.from !== b.from) return a.from < b.from ? -1 : 1;
    if (a.to !== b.to) return a.to < b.to ? -1 : 1;
    return a.verb < b.verb ? -1 : a.verb > b.verb ? 1 : 0;
  });

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Whole-range overview: every changed entity in the graph, rolled up. */
export function buildOverviewStory(
  entities: readonly Entity[],
  relationships: readonly Relationship[]
): StoryProjection {
  return project(entities, relationships, () => true, () => true);
}

/**
 * Per-change-unit story: only entities attached to the unit are counted, and
 * only relationships with BOTH endpoints attached to the unit become edges.
 * Ownership is still resolved against the full graph, so leaves roll up into
 * the right system even when the system entity itself isn't on the unit.
 */
export function buildUnitStory(
  unit: ChangeUnit,
  entities: readonly Entity[],
  relationships: readonly Relationship[]
): StoryProjection {
  const attached = new Set(unit.entities ?? []);
  return project(
    entities,
    relationships,
    (id) => attached.has(id),
    (r) => attached.has(r.from) && attached.has(r.to)
  );
}
