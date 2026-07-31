/**
 * Deterministic layered layout for the diagram compiler.
 *
 * - Topological ranks follow relationship direction (longest path from the
 *   sources); cycles are broken deterministically.
 * - At most MAX_NODES_PER_ROW nodes per row — wider ranks wrap onto extra
 *   rows, matching the design mandate "max 5 nodes horizontally".
 * - Fixed node size on a fixed grid; orthogonal-ish polyline edges with a
 *   label midpoint for the verb.
 * - Everything is stable-sorted by id, so the same input always produces the
 *   same layout (byte-identical SVG downstream, diffable output).
 *
 * Pure geometry only — no markup, no escaping. The diagram module owns SVG.
 */

import type { Entity, Relationship } from "@gitiviz/schema";

export const NODE_WIDTH = 172;
export const NODE_HEIGHT = 64;
export const MAX_NODES_PER_ROW = 5;
export const H_GAP = 36;
export const V_GAP = 64;
export const PADDING = 24;

export interface Point {
  x: number;
  y: number;
}

export interface LayoutNode {
  entity: Entity;
  /** Zero-based visual row (rank rows wrap when wider than MAX_NODES_PER_ROW). */
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutEdge {
  relationship: Relationship;
  /** Orthogonal-ish polyline from source border to target border. */
  points: Point[];
  /** Midpoint where the verb label sits. */
  label: Point;
}

export interface Layout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Longest-path layering: rank(node) = 1 + max rank of its predecessors,
 * sources at rank 0. Back edges that would close a cycle are ignored for
 * ranking (deterministically, thanks to the sorted iteration order).
 */
function computeRanks(
  sortedEntities: readonly Entity[],
  sortedRelationships: readonly Relationship[]
): Map<string, number> {
  const predecessors = new Map<string, string[]>();
  for (const entity of sortedEntities) predecessors.set(entity.id, []);
  for (const relationship of sortedRelationships) {
    predecessors.get(relationship.to)!.push(relationship.from);
  }

  const rank = new Map<string, number>();
  const inStack = new Set<string>();

  function rankOf(id: string): number {
    const known = rank.get(id);
    if (known !== undefined) return known;
    if (inStack.has(id)) return -1; // cycle back edge: contributes nothing
    inStack.add(id);
    let value = 0;
    for (const predecessor of predecessors.get(id)!) {
      value = Math.max(value, rankOf(predecessor) + 1);
    }
    inStack.delete(id);
    rank.set(id, value);
    return value;
  }

  for (const entity of sortedEntities) rankOf(entity.id);
  return rank;
}

function routeEdge(
  relationship: Relationship,
  from: LayoutNode,
  to: LayoutNode
): LayoutEdge {
  const fromCx = from.x + from.width / 2;
  const toCx = to.x + to.width / 2;

  if (to.row !== from.row) {
    const downward = to.row > from.row;
    const startY = downward ? from.y + from.height : from.y;
    const endY = downward ? to.y : to.y + to.height;
    const midY = Math.round((startY + endY) / 2);
    const points: Point[] =
      fromCx === toCx
        ? [
            { x: fromCx, y: startY },
            { x: toCx, y: endY }
          ]
        : [
            { x: fromCx, y: startY },
            { x: fromCx, y: midY },
            { x: toCx, y: midY },
            { x: toCx, y: endY }
          ];
    return {
      relationship,
      points,
      label: { x: Math.round((fromCx + toCx) / 2), y: midY - 6 }
    };
  }

  // Same row: straight horizontal edge between facing borders.
  const y = from.y + from.height / 2;
  const [startX, endX] =
    fromCx < toCx ? [from.x + from.width, to.x] : [from.x, to.x + to.width];
  return {
    relationship,
    points: [
      { x: startX, y },
      { x: endX, y }
    ],
    label: { x: Math.round((startX + endX) / 2), y: y - 8 }
  };
}

/**
 * Lay out entities and relationships on a fixed grid. Relationships whose
 * endpoints are missing from `entities` (or that are self-loops) are dropped:
 * they cannot be drawn.
 */
export function layoutGraph(
  entities: readonly Entity[],
  relationships: readonly Relationship[]
): Layout {
  const sortedEntities = [...entities].sort(byId);
  const known = new Set(sortedEntities.map((entity) => entity.id));
  const sortedRelationships = relationships
    .filter(
      (relationship) =>
        known.has(relationship.from) &&
        known.has(relationship.to) &&
        relationship.from !== relationship.to
    )
    .sort(byId);

  const ranks = computeRanks(sortedEntities, sortedRelationships);

  // Group by rank (entities are id-sorted, so each group stays id-sorted),
  // then wrap groups wider than MAX_NODES_PER_ROW.
  const byRank = new Map<number, Entity[]>();
  for (const entity of sortedEntities) {
    const rank = ranks.get(entity.id)!;
    const group = byRank.get(rank);
    if (group) group.push(entity);
    else byRank.set(rank, [entity]);
  }
  const rows: Entity[][] = [];
  for (const rank of [...byRank.keys()].sort((a, b) => a - b)) {
    const group = byRank.get(rank)!;
    for (let i = 0; i < group.length; i += MAX_NODES_PER_ROW) {
      rows.push(group.slice(i, i + MAX_NODES_PER_ROW));
    }
  }

  const widest = rows.reduce((max, row) => Math.max(max, row.length), 1);
  const contentWidth = widest * NODE_WIDTH + (widest - 1) * H_GAP;
  const width = contentWidth + 2 * PADDING;
  const height =
    2 * PADDING +
    rows.length * NODE_HEIGHT +
    Math.max(0, rows.length - 1) * V_GAP;

  const nodes: LayoutNode[] = [];
  const nodeById = new Map<string, LayoutNode>();
  rows.forEach((row, rowIndex) => {
    const rowWidth = row.length * NODE_WIDTH + (row.length - 1) * H_GAP;
    const startX = Math.round(PADDING + (contentWidth - rowWidth) / 2);
    const y = PADDING + rowIndex * (NODE_HEIGHT + V_GAP);
    row.forEach((entity, columnIndex) => {
      const node: LayoutNode = {
        entity,
        row: rowIndex,
        x: startX + columnIndex * (NODE_WIDTH + H_GAP),
        y,
        width: NODE_WIDTH,
        height: NODE_HEIGHT
      };
      nodes.push(node);
      nodeById.set(entity.id, node);
    });
  });

  const edges = sortedRelationships.map((relationship) =>
    routeEdge(relationship, nodeById.get(relationship.from)!, nodeById.get(relationship.to)!)
  );

  return { nodes, edges, width, height };
}
