/**
 * C4-style SVG diagram compiler — static inline SVG built at build time.
 *
 * Three diagram kinds for v0.1:
 *   1. Context diagram (systems chapter): C4 level 1 — person / system /
 *      external-system box styles, boundary rectangle around the application.
 *   2. Change diagram (change chapters): one diagram with change-state
 *      styling — `+` new = dashed accent border + "New" tag, `~` changed =
 *      accent border + "Changed" tag, `−` removed = faded + struck label,
 *      `=` quiet neutral. Every edge carries its verb as a `<text>` label.
 *   3. Sequence lanes (runtime flow): 2–4 vertical lanes, numbered steps.
 *
 * Rules (design doc + user mandates):
 *   - Light theme only: white surfaces, neutral grays, one accent.
 *   - All repo-controlled text through escape.ts; no `<foreignObject>`, no
 *     `<script>`, no `href`/`xlink`, no `url()` — the SVG references nothing.
 *   - `<title>` + role="img" + aria-label for accessibility; scales via
 *     viewBox + max-width:100%. Color is never the only carrier of meaning
 *     (tags and dash patterns restate every state).
 *   - Deterministic: layout is stable-sorted, no randomness, no timestamps —
 *     same input, byte-identical output.
 */

import type { ChangeState, ChangeUnit, Entity, Relationship } from "@gitiviz/schema";
import { escAttr, escHtml } from "./escape.js";
import {
  layoutGraph,
  type LayoutEdge,
  type LayoutNode,
  type Point
} from "./layout.js";
import type { DiagramRequest } from "./render.js";

// ---------------------------------------------------------------------------
// Palette (matches the HTML shell: neutral grays + the one accent)
// ---------------------------------------------------------------------------

const ACCENT = "#1d4ed8";
const INK = "#1f2937";
const MUTED = "#6b7280";
const BORDER = "#d1d5db";
const BORDER_STRONG = "#9ca3af";
const SURFACE = "#f9fafb";
const WHITE = "#ffffff";
const FONT =
  "-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif";

const LABEL_MAX = 24;
const SUBLABEL_MAX = 28;
const VERB_MAX = 32;

/** Code-point-safe truncation with an ellipsis (runs before escaping). */
function truncate(value: string, max: number): string {
  const codePoints = [...value];
  if (codePoints.length <= max) return value;
  return codePoints.slice(0, max - 1).join("") + "…";
}

// ---------------------------------------------------------------------------
// SVG primitives (every dynamic string escapes on the way out)
// ---------------------------------------------------------------------------

function svgRoot(width: number, height: number, label: string, body: string): string {
  return (
    `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" ` +
    `role="img" aria-label="${escAttr(label)}" ` +
    `style="max-width:100%;height:auto" font-family="${FONT}">` +
    `<title>${escHtml(label)}</title>` +
    body +
    `</svg>`
  );
}

interface NodeStyle {
  stroke: string;
  strokeWidth?: number;
  dash?: string;
  fill?: string;
  rx?: number;
  opacity?: number;
  /** Strike the human label (removed entities). */
  struck?: boolean;
  /** Small state/kind tag in the top-right corner ("+ New", "Person"…). */
  tag?: string;
  tagFill?: string;
  labelFill?: string;
}

function nodeSvg(node: LayoutNode, style: NodeStyle): string {
  const { entity } = node;
  const cx = node.x + node.width / 2;
  const fullTitle = entity.technicalLabel
    ? `${entity.humanLabel} — ${entity.technicalLabel}`
    : entity.humanLabel;

  let g = `<g${style.opacity !== undefined ? ` opacity="${style.opacity}"` : ""}>`;
  g += `<title>${escHtml(fullTitle)}</title>`;
  g +=
    `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" ` +
    `rx="${style.rx ?? 8}" fill="${style.fill ?? WHITE}" stroke="${style.stroke}" ` +
    `stroke-width="${style.strokeWidth ?? 1.5}"` +
    (style.dash ? ` stroke-dasharray="${style.dash}"` : "") +
    `/>`;
  if (style.tag) {
    g +=
      `<text x="${node.x + node.width - 8}" y="${node.y + 14}" text-anchor="end" ` +
      `font-size="9" fill="${style.tagFill ?? MUTED}">${escHtml(style.tag)}</text>`;
  }
  const labelY = entity.technicalLabel ? node.y + 30 : node.y + 37;
  g +=
    `<text x="${cx}" y="${labelY}" text-anchor="middle" font-size="12" ` +
    `font-weight="600" fill="${style.labelFill ?? INK}"` +
    (style.struck ? ` text-decoration="line-through"` : "") +
    `>${escHtml(truncate(entity.humanLabel, LABEL_MAX))}</text>`;
  if (entity.technicalLabel) {
    g +=
      `<text x="${cx}" y="${node.y + 47}" text-anchor="middle" font-size="10" ` +
      `fill="${MUTED}">${escHtml(truncate(entity.technicalLabel, SUBLABEL_MAX))}</text>`;
  }
  g += `</g>`;
  return g;
}

/** Filled triangle at `tip`, oriented along the (axis-aligned) last segment. */
function arrowHead(prev: Point, tip: Point, fill: string): string {
  const half = 5;
  const depth = 8;
  let a: Point;
  let b: Point;
  if (tip.x === prev.x) {
    const dir = tip.y > prev.y ? 1 : -1;
    a = { x: tip.x - half, y: tip.y - dir * depth };
    b = { x: tip.x + half, y: tip.y - dir * depth };
  } else {
    const dir = tip.x > prev.x ? 1 : -1;
    a = { x: tip.x - dir * depth, y: tip.y - half };
    b = { x: tip.x - dir * depth, y: tip.y + half };
  }
  return `<path d="M${tip.x} ${tip.y} L${a.x} ${a.y} L${b.x} ${b.y} Z" fill="${fill}"/>`;
}

interface EdgeStyle {
  stroke: string;
  dash?: string;
  opacity?: number;
  labelFill?: string;
}

/** White-halo text so verb labels stay readable when crossing lines. */
function haloText(x: number, y: number, fill: string, fontSize: number, content: string): string {
  return (
    `<text x="${x}" y="${y}" text-anchor="middle" font-size="${fontSize}" ` +
    `fill="${fill}" paint-order="stroke" stroke="${WHITE}" stroke-width="3">` +
    content +
    `</text>`
  );
}

function edgeSvg(edge: LayoutEdge, style: EdgeStyle): string {
  const points = edge.points;
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");
  let g = `<g${style.opacity !== undefined ? ` opacity="${style.opacity}"` : ""}>`;
  g +=
    `<path d="${d}" fill="none" stroke="${style.stroke}" stroke-width="1.5"` +
    (style.dash ? ` stroke-dasharray="${style.dash}"` : "") +
    `/>`;
  g += arrowHead(points[points.length - 2]!, points[points.length - 1]!, style.stroke);
  g += haloText(
    edge.label.x,
    edge.label.y,
    style.labelFill ?? MUTED,
    10,
    escHtml(truncate(edge.relationship.verb, VERB_MAX))
  );
  g += `</g>`;
  return g;
}

// ---------------------------------------------------------------------------
// 1. Context diagram (C4 level 1)
// ---------------------------------------------------------------------------

export interface ContextDiagramOptions {
  /** Label on the application boundary rectangle. Default "System boundary". */
  boundaryLabel?: string;
}

function isPerson(entity: Entity): boolean {
  return entity.kind === "person";
}

function isExternal(entity: Entity): boolean {
  return entity.kind === "external" || entity.kind.startsWith("external-");
}

function contextNodeStyle(entity: Entity): NodeStyle {
  if (isPerson(entity)) {
    return { stroke: BORDER_STRONG, rx: 18, tag: "Person" };
  }
  if (isExternal(entity)) {
    return { stroke: BORDER, fill: SURFACE, tag: "External", labelFill: MUTED };
  }
  return { stroke: ACCENT };
}

export function contextDiagram(
  entities: readonly Entity[],
  relationships: readonly Relationship[],
  options: ContextDiagramOptions = {}
): string {
  const layout = layoutGraph(entities, relationships);
  const internal = layout.nodes.filter(
    (node) => !isPerson(node.entity) && !isExternal(node.entity)
  );

  let boundary = "";
  let height = layout.height;
  if (internal.length > 0) {
    const minX = Math.min(...internal.map((n) => n.x)) - 12;
    const minY = Math.min(...internal.map((n) => n.y)) - 12;
    const maxX = Math.max(...internal.map((n) => n.x + n.width)) + 12;
    const maxY = Math.max(...internal.map((n) => n.y + n.height)) + 26;
    boundary =
      `<g>` +
      `<rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" ` +
      `rx="10" fill="${SURFACE}" stroke="${BORDER}" stroke-dasharray="4 4"/>` +
      `<text x="${minX + 10}" y="${maxY - 9}" font-size="10" fill="${MUTED}">` +
      escHtml(options.boundaryLabel ?? "System boundary") +
      `</text>` +
      `</g>`;
    height = Math.max(height, maxY + 12);
  }

  const personCount = layout.nodes.filter((n) => isPerson(n.entity)).length;
  const externalCount = layout.nodes.filter((n) => isExternal(n.entity)).length;
  const systemCount = layout.nodes.length - personCount - externalCount;
  const label =
    `Context diagram: ${personCount} people, ${systemCount} systems, ` +
    `${externalCount} external systems, ${layout.edges.length} connections.`;

  const body =
    boundary +
    layout.edges.map((edge) => edgeSvg(edge, { stroke: BORDER_STRONG })).join("") +
    layout.nodes.map((node) => nodeSvg(node, contextNodeStyle(node.entity))).join("");

  return svgRoot(layout.width, height, label, body);
}

// ---------------------------------------------------------------------------
// 2. Change diagram (before → after with change-state styling)
// ---------------------------------------------------------------------------

function changeNodeStyle(state: ChangeState): NodeStyle {
  switch (state) {
    case "added":
      return { stroke: ACCENT, dash: "6 4", tag: "+ New", tagFill: ACCENT };
    case "changed":
      return { stroke: ACCENT, strokeWidth: 2, tag: "~ Changed", tagFill: ACCENT };
    case "removed":
      return {
        stroke: BORDER_STRONG,
        fill: SURFACE,
        opacity: 0.45,
        struck: true,
        tag: "− Removed",
        tagFill: MUTED,
        labelFill: MUTED
      };
    case "unchanged":
      return { stroke: BORDER };
  }
}

function changeEdgeStyle(state: ChangeState): EdgeStyle {
  switch (state) {
    case "added":
      return { stroke: ACCENT, dash: "6 4", labelFill: ACCENT };
    case "changed":
      return { stroke: ACCENT, labelFill: ACCENT };
    case "removed":
      return { stroke: BORDER_STRONG, dash: "3 3", opacity: 0.45 };
    case "unchanged":
      return { stroke: BORDER_STRONG };
  }
}

export function changeDiagram(
  entities: readonly Entity[],
  relationships: readonly Relationship[],
  changeUnit?: ChangeUnit
): string {
  const layout = layoutGraph(entities, relationships);

  const counts: Record<ChangeState, number> = {
    added: 0,
    changed: 0,
    removed: 0,
    unchanged: 0
  };
  for (const node of layout.nodes) counts[node.entity.headState] += 1;

  const subject = changeUnit
    ? changeUnit.humanTitle ?? changeUnit.technicalTitle
    : "this change";
  const label =
    `Before and after: ${subject} — ${counts.added} new, ${counts.changed} changed, ` +
    `${counts.removed} removed, ${counts.unchanged} unchanged.`;

  const body =
    layout.edges
      .map((edge) => edgeSvg(edge, changeEdgeStyle(edge.relationship.headState)))
      .join("") +
    layout.nodes
      .map((node) => nodeSvg(node, changeNodeStyle(node.entity.headState)))
      .join("");

  return svgRoot(layout.width, layout.height, label, body);
}

// ---------------------------------------------------------------------------
// 3. Sequence lanes (runtime flow)
// ---------------------------------------------------------------------------

export interface SequenceLane {
  id: string;
  humanLabel: string;
  technicalLabel?: string;
}

export interface SequenceStep {
  from: string;
  to: string;
  text: string;
}

const LANE_WIDTH = 172;
const LANE_GAP = 48;
const LANE_HEAD_HEIGHT = 48;
const STEP_GAP = 44;
const SEQ_PADDING = 24;

export function sequenceDiagram(
  lanes: readonly SequenceLane[],
  steps: readonly SequenceStep[],
  options: { title?: string } = {}
): string {
  if (lanes.length < 2 || lanes.length > 4) {
    throw new RangeError(
      `sequence diagram needs 2–4 lanes, got ${lanes.length}`
    );
  }

  const width =
    2 * SEQ_PADDING + lanes.length * LANE_WIDTH + (lanes.length - 1) * LANE_GAP;
  const lifelineTop = SEQ_PADDING + LANE_HEAD_HEIGHT;
  const lifelineBottom = lifelineTop + 24 + steps.length * STEP_GAP + 12;
  const height = lifelineBottom + SEQ_PADDING;

  const centers = new Map<string, number>();
  lanes.forEach((lane, i) => {
    centers.set(lane.id, SEQ_PADDING + i * (LANE_WIDTH + LANE_GAP) + LANE_WIDTH / 2);
  });

  let body = "";
  lanes.forEach((lane, i) => {
    const x = SEQ_PADDING + i * (LANE_WIDTH + LANE_GAP);
    const cx = x + LANE_WIDTH / 2;
    const fullTitle = lane.technicalLabel
      ? `${lane.humanLabel} — ${lane.technicalLabel}`
      : lane.humanLabel;
    body += `<g>`;
    body += `<title>${escHtml(fullTitle)}</title>`;
    body +=
      `<path d="M${cx} ${lifelineTop} L${cx} ${lifelineBottom}" ` +
      `fill="none" stroke="${BORDER}" stroke-dasharray="4 4"/>`;
    body +=
      `<rect x="${x}" y="${SEQ_PADDING}" width="${LANE_WIDTH}" height="${LANE_HEAD_HEIGHT}" ` +
      `rx="8" fill="${WHITE}" stroke="${BORDER_STRONG}" stroke-width="1.5"/>`;
    const labelY = lane.technicalLabel ? SEQ_PADDING + 21 : SEQ_PADDING + 29;
    body +=
      `<text x="${cx}" y="${labelY}" text-anchor="middle" font-size="12" ` +
      `font-weight="600" fill="${INK}">${escHtml(truncate(lane.humanLabel, LABEL_MAX))}</text>`;
    if (lane.technicalLabel) {
      body +=
        `<text x="${cx}" y="${SEQ_PADDING + 37}" text-anchor="middle" font-size="10" ` +
        `fill="${MUTED}">${escHtml(truncate(lane.technicalLabel, SUBLABEL_MAX))}</text>`;
    }
    body += `</g>`;
  });

  steps.forEach((step, i) => {
    const from = centers.get(step.from);
    const to = centers.get(step.to);
    if (from === undefined || to === undefined) {
      throw new Error(
        `sequence step ${i + 1} references an unknown lane (${
          from === undefined ? step.from : step.to
        })`
      );
    }
    const y = lifelineTop + 40 + i * STEP_GAP;
    const numbered = `${i + 1}. ${step.text}`;
    body += `<g>`;
    if (from === to) {
      // Self-directed step: small rightward loop back onto the lifeline.
      const loopX = from + 32;
      body +=
        `<path d="M${from} ${y} L${loopX} ${y} L${loopX} ${y + 14} L${from + 8} ${y + 14}" ` +
        `fill="none" stroke="${INK}" stroke-width="1.5"/>`;
      body += arrowHead({ x: loopX, y: y + 14 }, { x: from + 8, y: y + 14 }, INK);
      body += haloText(from + 24, y - 8, INK, 10, escHtml(truncate(numbered, VERB_MAX + 8)));
    } else {
      body +=
        `<path d="M${from} ${y} L${to} ${y}" fill="none" stroke="${INK}" stroke-width="1.5"/>`;
      body += arrowHead({ x: from, y }, { x: to, y }, INK);
      body += haloText(
        Math.round((from + to) / 2),
        y - 8,
        INK,
        10,
        escHtml(truncate(numbered, VERB_MAX + 8))
      );
    }
    body += `</g>`;
  });

  const label = options.title
    ? `Sequence diagram: ${options.title} — ${steps.length} steps across ${lanes.length} lanes.`
    : `Sequence diagram: ${steps.length} steps across ${lanes.length} lanes.`;

  return svgRoot(width, height, label, body);
}

// ---------------------------------------------------------------------------
// RenderDiagram entry point (plugs into renderChangeBook)
// ---------------------------------------------------------------------------

/**
 * Compile a chapter projection into static inline SVG. Returns null for an
 * empty projection so the shell renders its quiet placeholder instead.
 * Satisfies the `RenderDiagram` callback type from render.ts.
 */
export function compileDiagram(request: DiagramRequest): string | null {
  if (request.entities.length === 0) return null;
  if (request.kind === "context") {
    return contextDiagram(request.entities, request.relationships);
  }
  return changeDiagram(request.entities, request.relationships, request.changeUnit);
}
