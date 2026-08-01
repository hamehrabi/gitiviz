/**
 * Mermaid compiler — turns validated diagram data into deterministic
 * Mermaid `flowchart TD` text in EXACTLY the dialect of the canonical
 * visual reference (docs/visual-reference.mmd):
 *
 *   - colored subgraph clusters,
 *   - concept-level 3-line node labels: Human name<br/>role<br/>[file],
 *   - verb-labeled edges: `n0 -->|"invoke"| n1`,
 *   - classDef tones from the user-approved palette,
 *   - click directives ONLY for files that exist in the evidence index,
 *     URL-validated against the configured repository origin.
 *
 * Two inputs compile here:
 *   1. `ConceptDiagram` specs (narrated architectureDiagram / storyDiagram)
 *      — already schema-validated structured data, never raw Mermaid;
 *   2. `StoryProjection` roll-ups from @gitiviz/core — the fallback when
 *      no narrated diagram exists (max 7 nodes by construction).
 *
 * Security: every label position is hostile input. Labels are neutralized
 * with Mermaid entity escapes (`#quot;` …) so no string can close a quote,
 * start a statement, or smuggle markup. Node/cluster ids are generated
 * locally (`n0`, `c0`, …) — spec ids never reach the output. Click URLs
 * pass through escape.ts's `safeUrl` allowlist (https always; http only
 * for configured origins) with per-segment percent-encoding.
 *
 * Deterministic by construction: input order is preserved, tones emit in a
 * fixed canonical order, no randomness, no timestamps.
 */

import type { ConceptDiagram, DiagramTone } from "@gitiviz/schema";
import type { StoryNode, StoryProjection } from "@gitiviz/core";
import { MAX_STORY_NODES } from "@gitiviz/core";
import { repoFileUrl } from "./links.js";

// ---------------------------------------------------------------------------
// Canonical palette (docs/visual-reference.mmd + the schema's sixth tone)
// ---------------------------------------------------------------------------

/** classDef bodies per tone — byte-for-byte the visual reference palette. */
export const MERMAID_TONE_CLASSDEFS: Record<DiagramTone, string> = {
  neutral: "fill:#f8fafc,stroke:#334155,stroke-width:1.5px,color:#0f172a",
  blue: "fill:#dbeafe,stroke:#2563eb,stroke-width:1.5px,color:#172554",
  amber: "fill:#fef3c7,stroke:#d97706,stroke-width:1.5px,color:#78350f",
  mint: "fill:#dcfce7,stroke:#16a34a,stroke-width:1.5px,color:#14532d",
  rose: "fill:#ffe4e6,stroke:#e11d48,stroke-width:1.5px,color:#881337",
  violet: "fill:#ede9fe,stroke:#7c3aed,stroke-width:1.5px,color:#2e1065"
};

/** Fixed emission order so identical inputs give identical class blocks. */
const TONE_ORDER: readonly DiagramTone[] = [
  "neutral",
  "blue",
  "amber",
  "mint",
  "rose",
  "violet"
];

const TONE_CLASS_NAMES: Record<DiagramTone, string> = {
  neutral: "toneNeutral",
  blue: "toneBlue",
  amber: "toneAmber",
  mint: "toneMint",
  rose: "toneRose",
  violet: "toneViolet"
};

// ---------------------------------------------------------------------------
// Escaping (hostile labels stay inert inside Mermaid quoted strings)
// ---------------------------------------------------------------------------

/**
 * Neutralize a repo-controlled string for use inside a Mermaid `"…"` label.
 * `#` first (it is the entity escape marker itself), then every character
 * that could close the quote or smuggle markup; whitespace runs collapse so
 * one statement per line stays true.
 */
function escLabel(value: string): string {
  return value
    .replace(/#/g, "#35;")
    .replace(/"/g, "#quot;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;")
    .replace(/&/g, "#amp;")
    .replace(/[|\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface MermaidCompileOptions {
  /**
   * Web URL prefix a node's file is appended to for click-through, e.g.
   * "https://github.com/acme/demo/blob/abc123". No clicks are emitted
   * without it, or when it fails the `safeUrl` allowlist.
   */
  linkBase?: string;
  /** Origins allowed to use http: (https: always passes). */
  allowedOrigins?: readonly string[];
  /**
   * Repo-relative paths that exist in the manifest's evidence index.
   * Click directives are emitted ONLY for these files.
   */
  existingFiles?: ReadonlySet<string>;
}

/**
 * Compose and validate the click URL for one file, or null when anything
 * about it is unsafe. Delegates to the shared repository-link policy in
 * links.ts (evidence-index membership → safeUrl → segment-encode →
 * recheck → same-origin), which the Sources list reuses.
 */
function clickUrl(file: string, options: MermaidCompileOptions): string | null {
  return repoFileUrl(file, options);
}

// ---------------------------------------------------------------------------
// Shared emitter
// ---------------------------------------------------------------------------

interface MermaidNode {
  /** Locally generated id (n0, n1, …). */
  id: string;
  /** Pre-escaped label lines, joined with <br/>. */
  labelLines: string[];
  tone: DiagramTone;
  /** Validated click URL, if any. */
  click?: string;
}

interface MermaidCluster {
  id: string;
  title: string;
  nodeIds: string[];
}

interface MermaidEdge {
  from: string;
  to: string;
  verb: string;
}

function nodeLine(node: MermaidNode): string {
  return `${node.id}["${node.labelLines.join("<br/>")}"]`;
}

function emit(
  clusters: MermaidCluster[],
  nodes: MermaidNode[],
  edges: MermaidEdge[]
): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const clustered = new Set(clusters.flatMap((c) => c.nodeIds));
  const lines: string[] = ["flowchart TD", ""];

  for (const cluster of clusters) {
    if (cluster.nodeIds.length === 0) continue;
    lines.push(`subgraph ${cluster.id}["${cluster.title}"]`);
    for (const id of cluster.nodeIds) lines.push(`  ${nodeLine(byId.get(id)!)}`);
    lines.push("end", "");
  }

  const loose = nodes.filter((n) => !clustered.has(n.id));
  if (loose.length > 0) {
    for (const node of loose) lines.push(nodeLine(node));
    lines.push("");
  }

  if (edges.length > 0) {
    for (const edge of edges) {
      lines.push(`${edge.from} -->|"${edge.verb}"| ${edge.to}`);
    }
    lines.push("");
  }

  const clicks = nodes.filter((n) => n.click !== undefined);
  if (clicks.length > 0) {
    for (const node of clicks) lines.push(`click ${node.id} "${node.click}" _blank`);
    lines.push("");
  }

  const usedTones = new Set(nodes.map((n) => n.tone));
  for (const tone of TONE_ORDER) {
    if (!usedTones.has(tone)) continue;
    lines.push(`classDef ${TONE_CLASS_NAMES[tone]} ${MERMAID_TONE_CLASSDEFS[tone]}`);
  }
  for (const tone of TONE_ORDER) {
    const members = nodes.filter((n) => n.tone === tone).map((n) => n.id);
    if (members.length === 0) continue;
    lines.push(`class ${members.join(",")} ${TONE_CLASS_NAMES[tone]}`);
  }

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// 1. Validated concept diagrams (narrated architecture / unit stories)
// ---------------------------------------------------------------------------

/**
 * Compile a schema-validated ConceptDiagram to Mermaid text in the
 * visual-reference dialect. Pure and byte-deterministic.
 */
export function conceptDiagramToMermaid(
  diagram: ConceptDiagram,
  options: MermaidCompileOptions = {}
): string {
  const clusterTone = new Map<string, DiagramTone>();
  const clusterId = new Map<string, string>();
  const clusters: MermaidCluster[] = (diagram.clusters ?? []).map((cluster, i) => {
    clusterTone.set(cluster.id, cluster.tone);
    clusterId.set(cluster.id, `c${i}`);
    return { id: `c${i}`, title: escLabel(cluster.title), nodeIds: [] };
  });
  const clustersById = new Map<string, MermaidCluster>(
    clusters.map((cluster) => [cluster.id, cluster])
  );

  const nodeId = new Map<string, string>();
  const nodes: MermaidNode[] = diagram.nodes.map((node, i) => {
    const id = `n${i}`;
    nodeId.set(node.id, id);
    const labelLines = [escLabel(node.humanLabel), escLabel(node.role)];
    if (node.file !== undefined) labelLines.push(`[${escLabel(node.file)}]`);
    const memberOf =
      node.cluster !== undefined ? clusterId.get(node.cluster) : undefined;
    if (memberOf !== undefined) clustersById.get(memberOf)!.nodeIds.push(id);
    const tone =
      node.cluster !== undefined
        ? (clusterTone.get(node.cluster) ?? "neutral")
        : "neutral";
    const click = node.file !== undefined ? clickUrl(node.file, options) : null;
    return { id, labelLines, tone, ...(click !== null ? { click } : {}) };
  });

  const edges: MermaidEdge[] = [];
  for (const edge of diagram.edges) {
    const from = nodeId.get(edge.from);
    const to = nodeId.get(edge.to);
    if (from === undefined || to === undefined) continue;
    edges.push({ from, to, verb: escLabel(edge.verb) });
  }

  return emit(clusters, nodes, edges);
}

// ---------------------------------------------------------------------------
// 2. Story projections (deterministic fallback, max 7 nodes)
// ---------------------------------------------------------------------------

const STATE_WORDS: Record<string, string> = {
  added: "new",
  changed: "updated",
  removed: "removed"
};

const STATE_TONES: Record<string, DiagramTone> = {
  added: "mint",
  changed: "blue",
  removed: "rose"
};

function storyRole(node: StoryNode): string {
  const count = `${node.count} change${node.count === 1 ? "" : "s"}`;
  if (node.kind === "system" || node.kind === "component") {
    const word = STATE_WORDS[node.changeState];
    return word !== undefined ? `${word} · ${count}` : count;
  }
  return count;
}

/**
 * Compile a story projection (already rolled up to reader level by
 * @gitiviz/core) to Mermaid text. Returns null for an empty story so the
 * caller renders its quiet placeholder. Never exceeds MAX_STORY_NODES.
 */
export function storyProjectionToMermaid(
  projection: StoryProjection
): string | null {
  if (projection.nodes.length === 0) return null;
  const kept = projection.nodes.slice(0, MAX_STORY_NODES);

  const nodeId = new Map<string, string>();
  const nodes: MermaidNode[] = kept.map((node, i) => {
    const id = `n${i}`;
    nodeId.set(node.id, id);
    const isContainer = node.kind === "system" || node.kind === "component";
    const tone = isContainer ? (STATE_TONES[node.changeState] ?? "neutral") : "neutral";
    return {
      id,
      labelLines: [escLabel(node.humanLabel), escLabel(storyRole(node))],
      tone
    };
  });

  const edges: MermaidEdge[] = [];
  for (const edge of projection.edges) {
    const from = nodeId.get(edge.from);
    const to = nodeId.get(edge.to);
    if (from === undefined || to === undefined) continue;
    edges.push({ from, to, verb: escLabel(edge.verb) });
  }

  return emit([], nodes, edges);
}
