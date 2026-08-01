/**
 * HTML shell renderer — one self-contained, scriptless, offline document.
 *
 * INTEGRATOR module: composes the three dashboard modules
 * (sidebar.ts / cards.ts / commitPage.ts — see dashboard-contract.md) into
 * the final document. This file owns:
 *   - the layout grid (sticky sidebar left, main content right)
 *   - the `:target` visibility mechanism (sections hidden by default,
 *     `:target` visible, Home visible when nothing is targeted)
 *   - concatenating the module CSS constants with the base light theme
 *     into the single `<style>`
 *   - the remaining views (Overview / Architecture / How it works / More)
 *     that regroup the ten canonical chapter projections
 *
 * Mandates (user + design doc "Reader experience"):
 *   - A LIGHT dashboard with a LEFT SIDEBAR NAV (repo wordmark + six view
 *     tabs); under ~736px it collapses to a horizontally scrollable tab row.
 *   - Home (the default view) is a grid of commit cards with CSS-only
 *     filter chips above it.
 *   - Clicking a card opens that commit's own page via anchor + `:target`
 *     (real URL fragments, so browser Back works).
 *   - Zero JavaScript. The CSP bans scripts entirely. Home is the LAST
 *     section so a plain sibling rule hides it when any other section is
 *     targeted — no `:has` required for the core mechanism (`:has` only
 *     upgrades the sidebar active-tab highlight; without it Home simply
 *     stays lit).
 *   - Explicit provenance markers (◇ AI interpretation, ✓ derived) — glyph
 *     + text, never colour as the only carrier.
 *   - Every repo-controlled string goes through escape.ts. Element ids and
 *     CSS selectors are generated locally (`home`, `u0`, `cd-filter-*`…),
 *     never repo-derived.
 */

import type {
  BookChapter,
  BookManifest,
  ChangeManifest,
  ChangeState,
  ChangeUnit,
  ChapterId,
  ConceptDiagram,
  Entity,
  EvidenceAnchor,
  Relationship
} from "@gitiviz/schema";
import {
  buildOverviewStory,
  buildUnitStory,
  type StoryProjection
} from "@gitiviz/core";
import { escHtml } from "./escape.js";
import { changeDiagram, contextDiagram } from "./diagram.js";
import {
  conceptDiagramToMermaid,
  storyProjectionToMermaid,
  type MermaidCompileOptions
} from "./mermaid.js";
import { renderSidebar, sidebarCss } from "./sidebar.js";
import { cardsCss, renderCardsGrid, renderFilterChips } from "./cards.js";
import { commitPageCss, renderCommitPage } from "./commitPage.js";
import { issuesCss, renderIssuesList, type IssueModel } from "./issues.js";
import { repoFileUrl, type RenderLinkOptions } from "./links.js";
import {
  toCardModel,
  toCommitPageModel,
  unitAnchorId,
  type ViewTab
} from "./dashboardTypes.js";

// ---------------------------------------------------------------------------
// Diagram insertion point (implemented by the diagram module)
// ---------------------------------------------------------------------------

/** Projection of one view's graph handed to the diagram compiler. */
export interface DiagramRequest {
  /** "context" = C4 level 1 (architecture view); "change" = before→after (commit pages). */
  kind: "context" | "change";
  entities: Entity[];
  relationships: Relationship[];
  /** Present for kind "change": the unit the diagram illustrates. */
  changeUnit?: ChangeUnit;
}

/**
 * Compiles a view projection into static inline SVG markup. Returning
 * `null` (or omitting the callback) renders a quiet placeholder instead.
 * The returned string is inserted verbatim — the diagram module owns its
 * escaping and must obey the same rules (no scripts, no external refs).
 * This is also the clean insertion point for a future Mermaid export
 * adapter.
 */
export type RenderDiagram = (request: DiagramRequest) => string | null;

/** One prerendered Mermaid diagram: the compiled source and its sanitized SVG. */
export interface PrerenderedDiagram {
  /** The exact mermaid text the SVG was rendered from (staleness check). */
  text: string;
  /** Sanitized standalone `<svg>` markup, inserted verbatim. */
  svg: string;
}

/** Mermaid diagram options threaded through the render. */
export interface MermaidRenderOptions {
  /**
   * Web URL prefix for click-through links to files, e.g.
   * "https://github.com/acme/demo/blob/abc123". Without it no click
   * directives are compiled.
   */
  linkBase?: string;
  /** Origins allowed to use http: links (https: always allowed). */
  allowedOrigins?: readonly string[];
  /**
   * Prerendered SVG per diagram slot id (see `collectMermaidSources`).
   * A slot whose stored `text` no longer matches the freshly compiled
   * source is ignored — the honest built-in fallback renders instead.
   */
  svgs?: ReadonlyMap<string, PrerenderedDiagram>;
}

export interface RenderOptions {
  renderDiagram?: RenderDiagram;
  /**
   * Display name for the sidebar wordmark. The CLI passes the repository
   * directory name (or a user-chosen name); when absent the manifest's
   * repository name is used.
   */
  repoName?: string;
  /** Mermaid concept diagrams (visual bar: docs/visual-reference.mmd). */
  mermaid?: MermaidRenderOptions;
  /**
   * Web-link policy (interface contract with the CLI): `linkBase` composes
   * evidence "Sources" links on commit pages via links.ts; `origin` is the
   * repository's web origin that issue-card links must match exactly.
   * Absent → paths render as plain text and issue cards stay linkless.
   */
  links?: RenderLinkOptions;
  /**
   * GitHub issues for the Issues tab (interface contract with the CLI,
   * which reads them defensively from the host-fetched issues.json).
   * Every string is still hostile input — the issues module escapes and
   * origin-validates on output. Absent or empty → the honest empty state.
   */
  issues?: readonly IssueModel[];
}

// ---------------------------------------------------------------------------
// Reading-experience constants
// ---------------------------------------------------------------------------

/** The one principal question each canonical chapter answers (design doc). */
const CHAPTER_QUESTIONS: Record<ChapterId, string> = {
  purpose: "Why does this system exist?",
  journeys: "Who uses it, and to do what?",
  systems: "What are the parts, and how do they fit together?",
  capabilities: "What can the system do?",
  flows: "How does work move through the system?",
  contracts: "What has the system promised to the outside world?",
  security: "Who can do what, and how is it protected?",
  operations: "How does it run, and how do we know it is healthy?",
  decisions: "Why is it built this way?",
  history: "How did it get here?"
};

const OVERVIEW_QUESTION = "What changed, and why does it matter?";

/**
 * Provenance markers (visual language: ◇ AI interpretation, ✓ derived).
 * Glyph + text + title attribute — colour is never the only carrier.
 * The `prov` class is the shared primitive reused (not restyled) by the
 * cards and commit-page modules.
 */
const INFERRED_MARK =
  `<span class="prov" title="AI interpretation: narrated title, not a derived fact">◇</span>`;

const DERIVED_MARK =
  `<span class="prov" title="Derived deterministically from the repository">✓</span>`;

// ---------------------------------------------------------------------------
// Commit types (conventional-commit prefix → reader-facing tag)
// ---------------------------------------------------------------------------

const COMMIT_TYPES = ["feature", "fix", "docs", "test", "housekeeping"] as const;

export type CommitType = (typeof COMMIT_TYPES)[number];

/**
 * Reader-facing commit type from the conventional-commit prefix of the
 * technical title. Anything unrecognized (refactor, chore, build, no prefix
 * at all) lands in the quiet "housekeeping" bucket. The result is a member
 * of a closed set — safe to use in class names and element ids.
 */
export function commitType(technicalTitle: string): CommitType {
  const match = /^([A-Za-z]+)(?:\([^)]*\))?!?:/.exec(technicalTitle);
  switch (match?.[1]?.toLowerCase()) {
    case "feat":
    case "feature":
      return "feature";
    case "fix":
      return "fix";
    case "doc":
    case "docs":
      return "docs";
    case "test":
    case "tests":
      return "test";
    default:
      return "housekeeping";
  }
}

// ---------------------------------------------------------------------------
// Small helpers (every repo string escapes on the way out)
// ---------------------------------------------------------------------------

const STATE_LABELS: Record<ChangeState, string> = {
  added: "+ New",
  changed: "~ Changed",
  removed: "− Removed",
  unchanged: "= Unchanged"
};

function shortRev(rev: string): string {
  return rev === "WORKTREE" ? "working tree" : rev.slice(0, 10);
}

/** 7-char commit sha for quiet evidence markers on timelines. */
function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function unitTitle(unit: ChangeUnit): string {
  return unit.humanTitle ?? unit.technicalTitle;
}

function anchorLine(anchor: EvidenceAnchor): string {
  let text = escHtml(anchor.path);
  if (anchor.range) {
    text += ` <span class="muted">lines ${anchor.range.startLine}–${anchor.range.endLine}</span>`;
  }
  if (anchor.symbol) {
    text += ` <span class="muted">· ${escHtml(anchor.symbol)}</span>`;
  }
  return `<li>${DERIVED_MARK} <code>${text}</code></li>`;
}

// ---------------------------------------------------------------------------
// Mermaid concept diagrams (visual bar: docs/visual-reference.mmd)
// ---------------------------------------------------------------------------

/** One diagram slot: a stable id ("architecture", "u0"…) and mermaid text. */
export interface MermaidSource {
  id: string;
  text: string;
}

/**
 * Honest note shown when a diagram fell back to the built-in engine. The
 * plugin ships Mermaid itself, so this should never appear in practice —
 * it means even the bundled engine failed to load, and the reader deserves
 * to know which engine actually drew what they are looking at.
 */
const MERMAID_FALLBACK_NOTE =
  "Rendered with the built-in diagram engine — the bundled Mermaid engine could not load here.";

/** Every evidence path in the manifest — the only files clicks may target. */
function evidenceFiles(change: ChangeManifest): ReadonlySet<string> {
  const files = new Set<string>();
  const collect = (anchors: EvidenceAnchor[] | undefined): void => {
    for (const anchor of anchors ?? []) files.add(anchor.path);
  };
  for (const entity of change.entities) collect(entity.evidence);
  for (const rel of change.relationships) collect(rel.evidence);
  for (const unit of change.changeUnits) collect(unit.evidence);
  return files;
}

function compileOptions(
  change: ChangeManifest,
  mermaid: MermaidRenderOptions | undefined
): MermaidCompileOptions {
  return {
    ...(mermaid?.linkBase !== undefined ? { linkBase: mermaid.linkBase } : {}),
    ...(mermaid?.allowedOrigins !== undefined
      ? { allowedOrigins: mermaid.allowedOrigins }
      : {}),
    existingFiles: evidenceFiles(change)
  };
}

/**
 * Origin-validated web URL per evidence path of one unit (links.ts
 * policy: evidence-index membership → safeUrl → segment-encode →
 * same-origin). Paths that fail any step simply get no map entry — the
 * commit-page module then renders them as plain escaped text.
 */
function unitSourceLinks(
  unit: ChangeUnit,
  change: ChangeManifest,
  links: RenderLinkOptions | undefined
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  if (links?.linkBase === undefined) return map;
  const policy = {
    linkBase: links.linkBase,
    ...(links.allowedOrigins !== undefined
      ? { allowedOrigins: links.allowedOrigins }
      : {}),
    existingFiles: evidenceFiles(change)
  };
  for (const anchor of unit.evidence ?? []) {
    if (map.has(anchor.path)) continue;
    const url = repoFileUrl(anchor.path, policy);
    if (url !== null) map.set(anchor.path, url);
  }
  return map;
}

/**
 * Mermaid source for the architecture hero: the narrated concept diagram
 * when present, else the whole-range story projection. Null when the
 * systems chapter is unwritten or the story is empty.
 */
function architectureMermaidSource(
  book: BookManifest,
  change: ChangeManifest,
  mermaid: MermaidRenderOptions | undefined
): string | null {
  const chapter = book.chapters.find((c) => c.id === "systems");
  if (chapter === undefined || chapter.status === "not-written") return null;
  if (change.architectureDiagram !== undefined) {
    return conceptDiagramToMermaid(
      change.architectureDiagram,
      compileOptions(change, mermaid)
    );
  }
  return storyProjectionToMermaid(
    buildOverviewStory(change.entities, change.relationships)
  );
}

/**
 * Mermaid source for one commit page: the unit's narrated story diagram
 * when present, else its story projection. Null for an empty story.
 */
function unitMermaidSource(
  unit: ChangeUnit,
  change: ChangeManifest,
  mermaid: MermaidRenderOptions | undefined
): string | null {
  if (unit.storyDiagram !== undefined) {
    return conceptDiagramToMermaid(unit.storyDiagram, compileOptions(change, mermaid));
  }
  return storyProjectionToMermaid(
    buildUnitStory(unit, change.entities, change.relationships)
  );
}

/**
 * Every mermaid diagram the book will show, one entry per slot, in
 * document order. The caller prerenders these (see mermaidSvg.ts) and
 * passes the results back as `RenderOptions.mermaid.svgs` keyed by `id`.
 * Pure and byte-deterministic — the same inputs always produce the same
 * texts `renderChangeBook` recompiles internally.
 */
export function collectMermaidSources(
  book: BookManifest,
  change: ChangeManifest,
  mermaid?: MermaidRenderOptions
): MermaidSource[] {
  const sources: MermaidSource[] = [];
  const architecture = architectureMermaidSource(book, change, mermaid);
  if (architecture !== null) sources.push({ id: "architecture", text: architecture });
  const meaningful = change.changeUnits.filter((unit) => !unit.grouped);
  meaningful.forEach((unit, index) => {
    const text = unitMermaidSource(unit, change, mermaid);
    if (text !== null) sources.push({ id: unitAnchorId(index), text });
  });
  return sources;
}

/** The prerendered SVG for a slot — only when its source text still matches. */
function prerenderedSvg(
  slotId: string,
  sourceText: string | null,
  mermaid: MermaidRenderOptions | undefined
): string | null {
  if (sourceText === null) return null;
  const entry = mermaid?.svgs?.get(slotId);
  if (entry === undefined || entry.text !== sourceText) return null;
  return entry.svg;
}

// ---------------------------------------------------------------------------
// Built-in fallback engine (honest stand-in when Mermaid is unavailable)
// ---------------------------------------------------------------------------

/** Synthesize concept-level entities from a story projection. */
function storyFallbackSvg(
  projection: StoryProjection,
  kind: "context" | "change"
): string | null {
  if (projection.nodes.length === 0) return null;
  const entities: Entity[] = projection.nodes.map((node) => ({
    id: node.id,
    kind: node.kind === "system" ? "system" : "component",
    humanLabel: node.humanLabel,
    technicalLabel: `${node.count} change${node.count === 1 ? "" : "s"}`,
    baseState: "unchanged",
    headState: node.changeState,
    provenance: "derived"
  }));
  const relationships: Relationship[] = projection.edges.map((edge, index) => ({
    id: `story-edge-${index}`,
    from: edge.from,
    to: edge.to,
    verb: edge.verb,
    baseState: "unchanged",
    headState: "unchanged",
    provenance: "derived"
  }));
  return kind === "context"
    ? contextDiagram(entities, relationships)
    : changeDiagram(entities, relationships);
}

/** Synthesize concept-level entities from a validated concept diagram. */
function conceptFallbackSvg(
  diagram: ConceptDiagram,
  kind: "context" | "change"
): string | null {
  if (diagram.nodes.length === 0) return null;
  const entities: Entity[] = diagram.nodes.map((node) => ({
    id: node.id,
    kind: "component",
    humanLabel: node.humanLabel,
    technicalLabel: node.role,
    baseState: "unchanged",
    headState: "unchanged",
    provenance: diagram.provenance
  }));
  const relationships: Relationship[] = diagram.edges.map((edge, index) => ({
    id: `concept-edge-${index}`,
    from: edge.from,
    to: edge.to,
    verb: edge.verb,
    baseState: "unchanged",
    headState: "unchanged",
    provenance: diagram.provenance
  }));
  return kind === "context"
    ? contextDiagram(entities, relationships)
    : changeDiagram(entities, relationships);
}

/**
 * The hero diagram figure: prerendered Mermaid SVG when available, else
 * the built-in fallback with its honest note, else a quiet placeholder.
 * The mermaid source text never ships in the page — diagrams carry their
 * own provenance; the source lives in `.gitiviz/dist/diagrams/`.
 */
function heroFigure(
  svg: string | null,
  mermaidRendered: boolean,
  caption: string
): string {
  const captionHtml =
    caption === "" ? "" : `<p class="caption">${escHtml(caption)}</p>`;
  if (svg === null) {
    return (
      captionHtml +
      `<figure class="diagram diagram-placeholder">` +
      `<p class="muted">Diagram not yet available.</p>` +
      `</figure>`
    );
  }
  const note = mermaidRendered
    ? ""
    : `<figcaption class="diagram-note">${escHtml(MERMAID_FALLBACK_NOTE)}</figcaption>`;
  return captionHtml + `<figure class="diagram">${svg}${note}</figure>`;
}

/**
 * Vertical commit timeline: one node per meaningful change unit — narrated
 * humanTitle when present (technicalTitle as fallback), short sha as muted
 * evidence — with grouped/fixup commits collapsed under a quiet
 * "N housekeeping commits" details element.
 */
function timeline(units: ChangeUnit[]): string {
  const meaningful = units.filter((unit) => !unit.grouped);
  const grouped = units.filter((unit) => unit.grouped);

  const shaHtml = (unit: ChangeUnit): string => {
    const sha = unit.commits?.[0];
    return sha ? ` <code class="timeline-sha">${escHtml(shortSha(sha))}</code>` : "";
  };

  const nodes = meaningful
    .map((unit) => {
      const mark = unit.provenance === "inferred" ? ` ${INFERRED_MARK}` : "";
      return (
        `<li><span class="timeline-title">${escHtml(unitTitle(unit))}</span>` +
        `${mark}${shaHtml(unit)}</li>`
      );
    })
    .join("");
  let html = `<ol class="timeline">${nodes}</ol>`;

  if (grouped.length > 0) {
    const items = grouped
      .map((unit) => {
        const reason = unit.groupedReason
          ? ` <span class="muted">(${escHtml(unit.groupedReason)})</span>`
          : "";
        return `<li>${escHtml(unit.technicalTitle)}${shaHtml(unit)}${reason}</li>`;
      })
      .join("");
    html +=
      `<details class="housekeeping"><summary>${grouped.length} housekeeping ` +
      `commit${grouped.length === 1 ? "" : "s"}</summary><ul>${items}</ul></details>`;
  }
  return html;
}

function entityList(entities: Entity[]): string {
  const items = entities
    .map((entity) => {
      let label = `<strong>${escHtml(entity.humanLabel)}</strong>`;
      if (entity.technicalLabel) {
        label += ` <span class="muted">· ${escHtml(entity.technicalLabel)}</span>`;
      }
      label += ` <span class="muted">(${STATE_LABELS[entity.headState]})</span>`;
      return `<li>${label}</li>`;
    })
    .join("");
  return `<ul class="entities">${items}</ul>`;
}

/**
 * The derived relationship dump as a bare `<ul>` (no heading — each caller
 * frames it: architectureView under its "Connections" h3, howItWorksView
 * inside the closed "Derived connections" fold). Empty string when the
 * manifest derived no relationships.
 */
function relationshipList(change: ChangeManifest): string {
  if (change.relationships.length === 0) return "";
  const byId = new Map(change.entities.map((entity) => [entity.id, entity]));
  const items = change.relationships
    .map((rel) => {
      const from = byId.get(rel.from)?.humanLabel ?? rel.from;
      const to = byId.get(rel.to)?.humanLabel ?? rel.to;
      return `<li>${escHtml(from)} —${escHtml(rel.verb)}→ ${escHtml(to)}</li>`;
    })
    .join("");
  return `<ul class="relationships">${items}</ul>`;
}

// ---------------------------------------------------------------------------
// Views (each becomes one <section> switched via :target)
// ---------------------------------------------------------------------------

/** View heading + the one principal question (or human lede) underneath. */
function viewHead(title: string, subtitle: string): string {
  const sub = subtitle === "" ? "" : `<p class="view-sub">${subtitle}</p>`;
  return `<h2>${escHtml(title)}</h2>${sub}`;
}

/**
 * Home (the default view): filter chips (CSS-only radios, module B) above
 * the commit cards grid (module B). The chip string emits its radio inputs
 * as top-level nodes, so placing it directly before the grid string under
 * this same `<section>` parent makes the inputs document siblings of
 * `.cd-filters` AND `.cd-grid` — exactly what the `~` selectors in
 * `cardsCss` require.
 */
function homeView(meaningful: ChangeUnit[], change: ChangeManifest): string {
  const count = meaningful.length;
  const head = viewHead(
    "All changes",
    `${count} meaningful change${count === 1 ? "" : "s"} · ` +
      `<span class="rev">${escHtml(shortRev(change.baseRevision))}</span> → ` +
      `<span class="rev">${escHtml(shortRev(change.headRevision))}</span>`
  );
  if (count === 0) {
    return head + `<p class="muted">No meaningful changes in this comparison.</p>`;
  }
  const present = COMMIT_TYPES.filter((type) =>
    meaningful.some((unit) => commitType(unit.technicalTitle) === type)
  );
  const cards = meaningful.map((unit, index) => toCardModel(unit, index, change));
  return head + renderFilterChips(present) + renderCardsGrid(cards);
}

/**
 * One commit's own page (module C), reached by clicking its card. It opens
 * with plain English (title, purpose, before/after) and only THEN shows the
 * small story diagram — prerendered Mermaid when available, the built-in
 * engine (plus honest note) otherwise. The full unit-scoped entity graph
 * from `renderDiagram` lands inside the collapsed Technical evidence fold,
 * never in the default view.
 */
function commitPageSection(
  unit: ChangeUnit,
  index: number,
  change: ChangeManifest,
  options: RenderOptions
): string {
  const entityIds = new Set(unit.entities ?? []);
  const entities = change.entities.filter((entity) => entityIds.has(entity.id));
  const relationshipIds = new Set(unit.relationships ?? []);
  const relationships =
    unit.relationships !== undefined
      ? change.relationships.filter((rel) => relationshipIds.has(rel.id))
      : change.relationships.filter(
          (rel) => entityIds.has(rel.from) && entityIds.has(rel.to)
        );
  const evidenceSvg = options.renderDiagram
    ? options.renderDiagram({ kind: "change", entities, relationships, changeUnit: unit })
    : null;

  const sourceText = unitMermaidSource(unit, change, options.mermaid);
  const mermaidSvg = prerenderedSvg(unitAnchorId(index), sourceText, options.mermaid);
  const fallbackSvg =
    mermaidSvg !== null || sourceText === null
      ? null
      : unit.storyDiagram !== undefined
        ? conceptFallbackSvg(unit.storyDiagram, "change")
        : storyFallbackSvg(
            buildUnitStory(unit, change.entities, change.relationships),
            "change"
          );
  const heroSvg = mermaidSvg ?? fallbackSvg;
  const sourceLinks = unitSourceLinks(unit, change, options.links);
  return renderCommitPage(toCommitPageModel(unit, index, change), heroSvg, {
    fallbackNote: fallbackSvg !== null ? MERMAID_FALLBACK_NOTE : null,
    evidenceSvg,
    ...(sourceLinks.size > 0 ? { sourceLinks } : {})
  });
}

/**
 * Overview: the narrated project lead (◇), the derived comparison line,
 * the narrated "Why it exists" key points (◇ each), what the repo is, and
 * the commit timeline. Honest absence: un-narrated slots render nothing.
 */
function overviewView(
  book: BookManifest,
  change: ChangeManifest,
  meaningful: ChangeUnit[]
): string {
  const count = meaningful.length;
  const countText = `${count} meaningful change${count === 1 ? "" : "s"}`;
  const lead =
    change.projectNarration === undefined
      ? ""
      : `<p class="lead">${INFERRED_MARK} ` +
        `${escHtml(change.projectNarration.summary)}</p>`;
  const purposePoints = change.chapterNarrations?.purpose?.keyPoints ?? [];
  const whyItExists =
    purposePoints.length === 0
      ? ""
      : `<h3>Why it exists</h3><ul class="keypoints">` +
        purposePoints
          .map((point) => `<li>${INFERRED_MARK} ${escHtml(point)}</li>`)
          .join("") +
        `</ul>`;
  const purposeChapter = book.chapters.find((chapter) => chapter.id === "purpose");
  const systems = change.entities.filter((entity) => entity.kind === "system");
  const purpose =
    purposeChapter?.status !== "not-written" && systems.length > 0
      ? `<h3>What this repository is</h3>` + entityList(systems)
      : "";
  const limitations =
    change.analysisLimitations.length === 0
      ? ""
      : `<details><summary>Analysis limitations</summary><ul>` +
        change.analysisLimitations
          .map((limitation) => `<li>${escHtml(limitation.message)}</li>`)
          .join("") +
        `</ul></details>`;
  return (
    viewHead("Overview", escHtml(OVERVIEW_QUESTION)) +
    lead +
    `<p>${escHtml(change.repository.name)}: ${countText} from ` +
    `<code>${escHtml(shortRev(change.baseRevision))}</code> to ` +
    `<code>${escHtml(shortRev(change.headRevision))}</code>.</p>` +
    whyItExists +
    purpose +
    `<h3>Commit timeline</h3>` +
    timeline(change.changeUnits) +
    limitations
  );
}

/**
 * Architecture: the narrated concept diagram (else the whole-range story
 * projection) rendered big and first, in the visual-reference language.
 * The full entity graph, entity list, connections, and anchors all fold
 * into the collapsed Technical evidence — never the default view.
 */
function architectureView(
  book: BookManifest,
  change: ChangeManifest,
  options: RenderOptions
): string {
  const head = viewHead("Architecture", escHtml(CHAPTER_QUESTIONS.systems));
  const chapter = book.chapters.find((c) => c.id === "systems");
  if (chapter === undefined || chapter.status === "not-written") {
    return head + `<p class="muted">Not yet written.</p>`;
  }

  const narration = change.chapterNarrations?.systems;
  const lede =
    narration === undefined
      ? ""
      : `<p>${INFERRED_MARK} ${escHtml(narration.summary)}</p>`;

  const sourceText = architectureMermaidSource(book, change, options.mermaid);
  const mermaidSvg = prerenderedSvg("architecture", sourceText, options.mermaid);
  const fallbackSvg =
    mermaidSvg !== null || sourceText === null
      ? null
      : change.architectureDiagram !== undefined
        ? conceptFallbackSvg(change.architectureDiagram, "context")
        : storyFallbackSvg(
            buildOverviewStory(change.entities, change.relationships),
            "context"
          );
  const hero = heroFigure(
    mermaidSvg ?? fallbackSvg,
    mermaidSvg !== null,
    "The systems this change touches, at a glance."
  );

  const fullGraph = options.renderDiagram
    ? options.renderDiagram({
        kind: "context",
        entities: change.entities,
        relationships: change.relationships
      })
    : null;
  const anchors = change.entities.flatMap((entity) => entity.evidence ?? []);
  const relationships = relationshipList(change);
  const evidence =
    `<details><summary>Technical evidence</summary>` +
    (fullGraph === null ? "" : `<figure class="diagram">${fullGraph}</figure>`) +
    entityList(change.entities) +
    (relationships === "" ? "" : `<h3>Connections</h3>` + relationships) +
    (anchors.length === 0
      ? ""
      : `<ul class="evidence">${anchors.map(anchorLine).join("")}</ul>`) +
    `</details>`;

  return head + lede + hero + evidence;
}

/** The question the How-it-works view answers now that it is a usage guide. */
const HOW_IT_WORKS_QUESTION = "How do I install and use it?";

/**
 * How it works: the narrated install-and-usage guide. The flows narration
 * renders as a ◇ lead plus numbered `ol.guide-steps`; the old derived
 * relationship dump survives only inside a closed "Derived connections"
 * fold. Honest fallbacks: narration absent but relationships present →
 * a pointer at /gitiviz:init above the fold; neither → "Not yet written."
 */
function howItWorksView(change: ChangeManifest): string {
  const head = viewHead("How it works", escHtml(HOW_IT_WORKS_QUESTION));
  const relationships = relationshipList(change);
  const connections =
    relationships === ""
      ? ""
      : `<details class="connections"><summary>Derived connections</summary>` +
        relationships +
        `</details>`;
  const narration = change.chapterNarrations?.flows;
  if (narration === undefined) {
    if (connections === "") {
      return head + `<p class="muted">Not yet written.</p>`;
    }
    return (
      head +
      `<p class="muted">No usage guide narrated yet — run /gitiviz:init.</p>` +
      connections
    );
  }
  const points = narration.keyPoints ?? [];
  const steps =
    points.length === 0
      ? ""
      : `<ol class="guide-steps">` +
        points.map((point) => `<li>${escHtml(point)}</li>`).join("") +
        `</ol>`;
  return (
    head +
    `<p class="lead">${INFERRED_MARK} ${escHtml(narration.summary)}</p>` +
    steps +
    connections
  );
}

/** The question the Issues view answers. */
const ISSUES_QUESTION = "What has been discussed and ticketed?";

/**
 * Issues: the GitHub tickets raised from this book's commit pages (module
 * issues.ts renders the cards; the host-side launcher fetched the data
 * with gh). Empty or absent issues render the honest empty state.
 */
function issuesView(options: RenderOptions): string {
  return (
    viewHead("Issues", escHtml(ISSUES_QUESTION)) +
    renderIssuesList(options.issues ?? [], options.links)
  );
}

/** More: the remaining book chapters, each folded until needed. */
const MORE_CHAPTER_IDS: readonly ChapterId[] = [
  "journeys",
  "capabilities",
  "contracts",
  "security",
  "operations",
  "decisions",
  "history"
];

function chapterFold(chapter: BookChapter, change: ChangeManifest): string {
  const question = `<p class="view-sub">${escHtml(CHAPTER_QUESTIONS[chapter.id])}</p>`;
  let content = `<p class="muted">Not yet written.</p>`;
  if (chapter.status !== "not-written" && chapter.id === "history") {
    content = timeline(change.changeUnits);
  }
  return (
    `<details class="fold"><summary>${escHtml(chapter.title)}</summary>` +
    question +
    content +
    `</details>`
  );
}

function moreView(book: BookManifest, change: ChangeManifest): string {
  const folds = MORE_CHAPTER_IDS.map((id) =>
    book.chapters.find((chapter) => chapter.id === id)
  )
    .filter((chapter): chapter is BookChapter => chapter !== undefined)
    .map((chapter) => chapterFold(chapter, change))
    .join("");
  return (
    viewHead("More", "The rest of the book, folded until needed.") + folds
  );
}

// ---------------------------------------------------------------------------
// Stylesheet (light theme only — user mandate; no dark scheme in v0.1)
// ---------------------------------------------------------------------------

/**
 * The sidebar module's active-tab look, mirrored by the shell's :target
 * rules so the highlight follows the targeted view. Keep in sync with
 * `.sb-item-active .sb-tab` in sidebarCss.
 */
const ACTIVE_TAB =
  `color:#1d4ed8;background:#eff6ff;border-left-color:#1d4ed8;font-weight:600`;
const INACTIVE_TAB =
  `color:#4b5563;background:transparent;border-left-color:transparent;font-weight:400`;
const FOCUS_RING = `outline:2px solid #1d4ed8;outline-offset:2px`;

/** View ids other than home (home is the :target-less default). */
const OTHER_VIEW_IDS = [
  "overview",
  "architecture",
  "how-it-works",
  "issues",
  "more"
] as const;

/**
 * Base/shell CSS: reset, light theme, layout grid, the `:target`
 * visibility mechanism, and the shared views (overview/architecture/
 * how-it-works/more, timeline, evidence). Module CSS (sb-/cd-/cp-) is
 * concatenated separately.
 */
function shellCss(): string {
  // Sidebar active-tab highlight follows the targeted view. Progressive
  // enhancement: browsers without :has simply keep Home lit (the static
  // sb-item-active class from the sidebar module). Commit pages (#u…)
  // deliberately keep Home lit — they belong to the Home view.
  const anyOtherTargeted = OTHER_VIEW_IDS.map((id) => `#${id}:target`).join(",");
  const tabRules = [
    `body:has(${anyOtherTargeted}) .sb-item-active .sb-tab{${INACTIVE_TAB}}`,
    ...OTHER_VIEW_IDS.map(
      (id) => `body:has(#${id}:target) .sb-tabs a[href="#${id}"]{${ACTIVE_TAB}}`
    )
  ];
  return [
    // Reset + base. System fonts, generous whitespace, neutral grays, one accent.
    `*,*::before,*::after{box-sizing:border-box}`,
    `body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;` +
      `color:#1f2937;background:#f9fafb;line-height:1.6}`,
    // Long repo-controlled tokens (paths, identifiers) must wrap so 320px
    // never scrolls horizontally.
    `h1,h2,h3,p,label,summary,figcaption,a{overflow-wrap:anywhere}`,
    `a:focus-visible{${FOCUS_RING}}`,
    // Skip link: clipped off-screen but focusable; revealed on focus.
    `.skip-link{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;` +
      `clip:rect(0 0 0 0);clip-path:inset(50%)}`,
    `.skip-link:focus{position:fixed;top:0.5rem;left:0.5rem;width:auto;height:auto;margin:0;` +
      `overflow:visible;clip:auto;clip-path:none;background:#ffffff;color:#1d4ed8;` +
      `padding:0.5rem 1rem;border:1px solid #1d4ed8;border-radius:4px;z-index:1}`,
    // Two-pane dashboard: the sidebar module's <nav> is the left column
    // (it carries its own width, stickiness, and 736px collapse); main
    // fills the rest.
    `.layout{display:flex;max-width:74rem;margin:0 auto;min-height:100vh}`,
    `main{flex:1;min-width:0;background:#ffffff;padding:2rem 2rem 4rem}`,
    // ------------------------------------------------------------------
    // The :target visibility mechanism. Every view and commit page is a
    // direct <section> child of main, hidden by default and shown when
    // targeted. Home is deliberately the LAST section: a plain general-
    // sibling rule hides it whenever ANY earlier section is targeted, so
    // the default view needs no :has and degrades sanely (no fragment →
    // Home; unknown fragment → Home; browser Back walks the fragment
    // history).
    // ------------------------------------------------------------------
    `main>section{display:none;padding-bottom:2rem}`,
    `main>section:target{display:block}`,
    `#home{display:block}`,
    `main>section:target~#home{display:none}`,
    `#overview,#architecture,#how-it-works,#issues,#more{max-width:44rem}`,
    ...tabRules,
    // Type scale: view heading > sidebar wordmark > metadata.
    `h2{font-size:1.5rem;font-weight:600;letter-spacing:-0.015em;margin:0 0 0.25rem}`,
    `.view-sub{color:#6b7280;font-size:1rem;margin:0.25rem 0 1.5rem}`,
    `.view-sub .rev{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;` +
      `font-size:0.8125rem;color:#9ca3af;overflow-wrap:anywhere}`,
    `h3{font-size:0.75rem;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;` +
      `color:#6b7280;margin:2rem 0 0.75rem}`,
    `p{margin:0.75rem 0}`,
    `.muted{color:#6b7280}`,
    // Narrated leads (◇): one breath of AI interpretation above the facts.
    `p.lead{font-size:1.0625rem;margin:0 0 1rem}`,
    // Narrated key points (◇ per item — the glyph is the list marker).
    `ul.keypoints{list-style:none;margin:0.5rem 0 1rem;padding-left:0}`,
    `ul.keypoints li{margin:0.375rem 0}`,
    // Narrated install/usage guide: the ol numbering IS the affordance.
    `ol.guide-steps{margin:0.75rem 0 1.25rem;padding-left:1.5rem}`,
    `ol.guide-steps li{margin:0.5rem 0}`,
    `code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.875em;` +
      `background:#f9fafb;border:1px solid #e5e7eb;border-radius:4px;padding:0.1em 0.35em;overflow-wrap:anywhere}`,
    `ul,ol{margin:0.5rem 0;padding-left:1.5rem}`,
    `li{margin:0.25rem 0;overflow-wrap:anywhere}`,
    // Provenance marks: glyph + title attribute; never colour-only. Shared
    // primitive reused by the cards and commit-page modules.
    `.prov{color:#6b7280;font-size:0.875em}`,
    // Diagrams get room; overflow-x:auto keeps an oversized diagram
    // scrolling inside its own figure instead of widening the page at 320px.
    `figure.diagram{margin:1.5rem 0;padding:1rem;border:1px solid #e5e7eb;border-radius:8px;` +
      `background:#ffffff;overflow-x:auto}`,
    `figure.diagram svg{display:block;max-width:100%;height:auto}`,
    `figure.diagram-placeholder{display:flex;align-items:center;justify-content:center;min-height:8rem;background:#f9fafb}`,
    // Honest fallback note under each diagram.
    `figure.diagram figcaption.diagram-note{margin:0.75rem 0 0;font-size:0.8125rem;color:#6b7280}`,
    `.caption{margin:1.5rem 0 0.5rem;font-size:1.0625rem}`,
    // Vertical commit timeline: hairline spine, one node per change unit.
    `ol.timeline{list-style:none;margin:1rem 0 0.5rem;padding:0}`,
    `ol.timeline li{position:relative;margin:0 0 0 0.375rem;padding:0 0 1.25rem 1.375rem;` +
      `border-left:1px solid #e5e7eb}`,
    `ol.timeline li:last-child{border-left-color:transparent;padding-bottom:0.25rem}`,
    `ol.timeline li::before{content:"";position:absolute;top:0.375rem;left:-0.34375rem;` +
      `width:0.625rem;height:0.625rem;border-radius:50%;background:#ffffff;border:1px solid #6b7280}`,
    `.timeline-title{font-weight:500}`,
    `code.timeline-sha{background:transparent;border:none;padding:0;color:#9ca3af;font-size:0.75rem}`,
    // Evidence and book folds stay collapsed and quiet.
    `details{margin:1.5rem 0;border:1px solid #e5e7eb;border-radius:8px;padding:0.5rem 1rem}`,
    `summary{cursor:pointer;color:#6b7280}`,
    `ul.evidence{list-style:none;padding-left:0}`,
    `details.fold{margin:0.75rem 0}`,
    `details.fold summary{color:#1f2937;font-weight:600}`,
    `details.fold .view-sub{margin:0.5rem 0 1rem;font-size:0.875rem}`,
    // Housekeeping commits: quieter than regular evidence details.
    `details.housekeeping{border:none;border-radius:0;padding:0;margin:0.25rem 0 0}`,
    `details.housekeeping summary{font-size:0.8125rem}`,
    // Under 736px the sidebar module collapses its <nav> to a horizontally
    // scrollable tab row; the shell stacks the layout so the page itself
    // never scrolls sideways at 320px. Breakpoint matches sidebarCss.
    `@media (max-width:736px){` +
      `.layout{flex-direction:column}` +
      `main{padding:1.5rem 1.25rem 3rem}` +
      `}`
  ].join("\n");
}

/** The single stylesheet: shell + the four module CSS constants. */
function stylesheet(): string {
  return [shellCss(), sidebarCss, cardsCss, commitPageCss, issuesCss].join("\n");
}

// ---------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------

const CSP_CONTENT = "default-src 'none'; style-src 'unsafe-inline'; img-src data:;";

const TABS: readonly ViewTab[] = [
  { id: "home", label: "Home", href: "#home" },
  { id: "overview", label: "Overview", href: "#overview" },
  { id: "architecture", label: "Architecture", href: "#architecture" },
  { id: "how-it-works", label: "How it works", href: "#how-it-works" },
  { id: "issues", label: "Issues", href: "#issues" },
  { id: "more", label: "More", href: "#more" }
];

/**
 * Render the change dashboard as one self-contained HTML document string.
 * Pure and deterministic: same manifests (and options) in, byte identical
 * document out.
 */
export function renderChangeBook(
  book: BookManifest,
  change: ChangeManifest,
  options: RenderOptions = {}
): string {
  const meaningful = change.changeUnits.filter((unit) => !unit.grouped);

  // Home is deliberately LAST: the pure-CSS default-view technique needs
  // every other (targetable) section — views and commit pages alike — to
  // precede it in document order. Commit-page roots come from module C
  // already wrapped as <section class="cp-page" id="u{index}">.
  const commitPages = meaningful
    .map((unit, index) => commitPageSection(unit, index, change, options))
    .join("");
  const sections =
    `<section id="overview">${overviewView(book, change, meaningful)}</section>` +
    `<section id="architecture">${architectureView(book, change, options)}</section>` +
    `<section id="how-it-works">${howItWorksView(change)}</section>` +
    `<section id="issues">${issuesView(options)}</section>` +
    `<section id="more">${moreView(book, change)}</section>` +
    commitPages +
    `<section id="home">${homeView(meaningful, change)}</section>`;

  const displayName = options.repoName ?? change.repository.name;
  const title = escHtml(`${displayName} — change book`);

  return (
    `<!doctype html>` +
    `<html lang="en">` +
    `<head>` +
    `<meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${CSP_CONTENT}">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${title}</title>` +
    `<style>${stylesheet()}</style>` +
    `</head>` +
    `<body>` +
    `<a class="skip-link" href="#main">Skip to content</a>` +
    `<div class="layout">` +
    renderSidebar(TABS, "home", displayName) +
    `<main id="main">` +
    sections +
    `</main>` +
    `</div>` +
    `</body>` +
    `</html>`
  );
}
