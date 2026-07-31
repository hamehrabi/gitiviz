/**
 * HTML shell renderer — one self-contained, scriptless, offline document.
 *
 * Mandates (user + design doc):
 *   - Clean, standard, low cognitive load. LIGHT THEME ONLY in v0.1: system
 *     font stack, generous whitespace, neutral grays + one accent. No
 *     gradients, no dashboards.
 *   - Zero JavaScript. The CSP bans scripts entirely; chapter switching is
 *     the pure-CSS radio/label technique (native elements, keyboard-safe).
 *   - Diagram-first: diagrams are the dominant content of each chapter,
 *     injected through the `renderDiagram` callback.
 *   - Reading experience: a proper masthead (display name + human subtitle,
 *     SHAs shortened and secondary), one principal question under each
 *     chapter heading, short pill nav labels grouped into "This change" /
 *     "The book", a vertical commit timeline, and explicit provenance
 *     markers (◇ AI interpretation, ✓ derived) — glyph + text, never colour
 *     as the only carrier.
 *   - Every repo-controlled string goes through escape.ts. Element ids and
 *     CSS selectors are generated locally (`c0`/`p0`…), never repo-derived.
 */

import type {
  BookChapter,
  BookManifest,
  ChangeManifest,
  ChangeState,
  ChangeUnit,
  ChapterId,
  Entity,
  EvidenceAnchor,
  Relationship
} from "@gitiviz/schema";
import { escHtml } from "./escape.js";

// ---------------------------------------------------------------------------
// Diagram insertion point (implemented by the diagram module)
// ---------------------------------------------------------------------------

/** Projection of one chapter's graph handed to the diagram compiler. */
export interface DiagramRequest {
  /** "context" = C4 level 1 (systems chapter); "change" = before→after (change chapters). */
  kind: "context" | "change";
  entities: Entity[];
  relationships: Relationship[];
  /** Present for kind "change": the unit the diagram illustrates. */
  changeUnit?: ChangeUnit;
}

/**
 * Compiles a chapter projection into static inline SVG markup. Returning
 * `null` (or omitting the callback) renders a quiet placeholder instead.
 * The returned string is inserted verbatim — the diagram module owns its
 * escaping and must obey the same rules (no scripts, no external refs).
 */
export type RenderDiagram = (request: DiagramRequest) => string | null;

export interface RenderOptions {
  renderDiagram?: RenderDiagram;
  /**
   * Display name for the masthead. The CLI passes the repository directory
   * name (or a user-chosen name); when absent the manifest's repository
   * name is used.
   */
  repoName?: string;
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

/** Nav labels stay short: truncate on a word boundary around this length. */
const NAV_LABEL_MAX = 30;

/**
 * Provenance markers (visual language: ◇ AI interpretation, ✓ derived).
 * Glyph + text + title attribute — colour is never the only carrier.
 */
const INFERRED_BADGE =
  `<span class="badge badge-inferred" ` +
  `title="AI interpretation: this text was written by the narrator from the derived facts. Verify it against the evidence.">` +
  `◇ AI interpretation</span>`;

const DERIVED_MARK =
  `<span class="prov" title="Derived deterministically from the repository">✓</span>`;

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

/** 7-char commit sha for quiet evidence markers in the timeline. */
function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function unitTitle(unit: ChangeUnit): string {
  return unit.humanTitle ?? unit.technicalTitle;
}

/**
 * Truncate a nav label at ~max characters on a word boundary. The full
 * title stays as the chapter heading; only the nav pill is shortened.
 */
function shortNavLabel(text: string, max: number = NAV_LABEL_MAX): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max + 1);
  const lastSpace = slice.lastIndexOf(" ");
  const head = (lastSpace > 0 ? slice.slice(0, lastSpace) : text.slice(0, max))
    .replace(/[\s.,;:·—–-]+$/u, "");
  return `${head}…`;
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

function evidenceDetails(anchors: EvidenceAnchor[]): string {
  if (anchors.length === 0) return "";
  return (
    `<details><summary>Technical evidence</summary>` +
    `<ul class="evidence">${anchors.map(anchorLine).join("")}</ul>` +
    `</details>`
  );
}

function diagramFigure(
  request: DiagramRequest,
  renderDiagram: RenderDiagram | undefined,
  caption: string
): string {
  const svg = renderDiagram ? renderDiagram(request) : null;
  const captionHtml = caption === "" ? "" : `<p class="caption">${escHtml(caption)}</p>`;
  if (svg === null) {
    return (
      captionHtml +
      `<figure class="diagram diagram-placeholder">` +
      `<p class="muted">Diagram not yet available.</p>` +
      `</figure>`
    );
  }
  return captionHtml + `<figure class="diagram">${svg}</figure>`;
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
      const mark =
        unit.provenance === "inferred"
          ? ` <span class="prov" title="AI interpretation: narrated title, not a derived fact">◇</span>`
          : "";
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

// ---------------------------------------------------------------------------
// Chapter bodies
// ---------------------------------------------------------------------------

interface RenderedChapter {
  /** Nav label, raw (escaped at emit time). Kept short — pills, not prose. */
  navLabel: string;
  /** Nav cluster: the change explainer or the ten-chapter book. */
  group: "change" | "book";
  /** Inner HTML of the chapter's <section>. */
  body: string;
}

/** Chapter heading + its principal question (or human lede) underneath. */
function chapterHead(title: string, subtitle: string): string {
  const sub = subtitle === "" ? "" : `<p class="chapter-sub">${subtitle}</p>`;
  return `<h2>${escHtml(title)}</h2>${sub}`;
}

function overviewChapter(change: ChangeManifest, meaningful: ChangeUnit[]): RenderedChapter {
  const count = meaningful.length;
  const countText = `${count} meaningful change${count === 1 ? "" : "s"}`;
  const limitations =
    change.analysisLimitations.length === 0
      ? ""
      : `<details><summary>Analysis limitations</summary><ul>` +
        change.analysisLimitations
          .map((limitation) => `<li>${escHtml(limitation.message)}</li>`)
          .join("") +
        `</ul></details>`;
  const body =
    chapterHead("Overview", escHtml(OVERVIEW_QUESTION)) +
    `<p>${escHtml(change.repository.name)}: ${countText} from ` +
    `<code>${escHtml(shortRev(change.baseRevision))}</code> to ` +
    `<code>${escHtml(shortRev(change.headRevision))}</code>.</p>` +
    `<h3>Commit timeline</h3>` +
    timeline(change.changeUnits) +
    limitations;
  return { navLabel: "Overview", group: "change", body };
}

function changeUnitChapter(
  unit: ChangeUnit,
  number: number,
  change: ChangeManifest,
  options: RenderOptions
): RenderedChapter {
  const entityIds = new Set(unit.entities ?? []);
  const entities = change.entities.filter((entity) => entityIds.has(entity.id));
  const relationshipIds = new Set(unit.relationships ?? []);
  const relationships =
    unit.relationships !== undefined
      ? change.relationships.filter((rel) => relationshipIds.has(rel.id))
      : change.relationships.filter(
          (rel) => entityIds.has(rel.from) && entityIds.has(rel.to)
        );

  const figure = diagramFigure(
    { kind: "change", entities, relationships, changeUnit: unit },
    options.renderDiagram,
    ""
  );

  // Lede under the heading: the one-sentence human outcome, marked ◇ when
  // it is AI narration rather than a derived restatement.
  const badge = unit.provenance === "inferred" ? INFERRED_BADGE : "";
  let lede = "";
  if (unit.summary) {
    lede = `${escHtml(unit.summary)}${badge === "" ? "" : ` ${badge}`}`;
  } else if (badge !== "") {
    lede = badge;
  }

  let narration = "";
  if (unit.beforeDescription) {
    narration += `<p><strong>Before:</strong> ${escHtml(unit.beforeDescription)}</p>`;
  }
  if (unit.afterDescription) {
    narration += `<p><strong>After:</strong> ${escHtml(unit.afterDescription)}</p>`;
  }
  if (unit.userImpact) {
    narration += `<p><strong>For users:</strong> ${escHtml(unit.userImpact)}</p>`;
  }
  if (unit.openQuestions && unit.openQuestions.length > 0) {
    narration +=
      `<h3>Open questions</h3><ul>` +
      unit.openQuestions.map((q) => `<li>? ${escHtml(q)}</li>`).join("") +
      `</ul>`;
  }

  const unchangedEntities = change.entities.filter(
    (entity) => entity.baseState === "unchanged" && entity.headState === "unchanged"
  );
  const unchanged =
    unchangedEntities.length === 0
      ? ""
      : `<h3>What stayed unchanged</h3><ul>` +
        unchangedEntities
          .map((entity) => `<li>${escHtml(entity.humanLabel)}</li>`)
          .join("") +
        `</ul>`;

  const anchors: EvidenceAnchor[] = [
    ...(unit.evidence ?? []),
    ...entities.flatMap((entity) => entity.evidence ?? [])
  ];

  const title = unitTitle(unit);
  const body =
    chapterHead(title, lede) + figure + narration + unchanged + evidenceDetails(anchors);
  return {
    navLabel: `${number} · ${shortNavLabel(title)}`,
    group: "change",
    body
  };
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
  return `<h3>Connections</h3><ul class="relationships">${items}</ul>`;
}

function bookChapter(
  chapter: BookChapter,
  change: ChangeManifest,
  options: RenderOptions
): RenderedChapter {
  const heading = chapterHead(chapter.title, escHtml(CHAPTER_QUESTIONS[chapter.id]));
  const navLabel = shortNavLabel(chapter.title);
  if (chapter.status === "not-written") {
    return {
      navLabel,
      group: "book",
      body: heading + `<p class="muted">Not yet written.</p>`
    };
  }
  let body = heading;
  switch (chapter.id) {
    case "purpose":
      body += `<p>${escHtml(change.repository.name)} — what this repository is for.</p>`;
      body += entityList(
        change.entities.filter((entity) => entity.kind === "system")
      );
      break;
    case "systems":
      body += diagramFigure(
        {
          kind: "context",
          entities: change.entities,
          relationships: change.relationships
        },
        options.renderDiagram,
        "The systems this change touches, at a glance."
      );
      body += entityList(change.entities);
      body += relationshipList(change);
      body += evidenceDetails(
        change.entities.flatMap((entity) => entity.evidence ?? [])
      );
      break;
    case "history":
      body += timeline(change.changeUnits);
      break;
    default:
      body += `<p class="muted">Not yet written.</p>`;
      break;
  }
  return { navLabel, group: "book", body };
}

/**
 * Previous/Next controls at the foot of each chapter. Scriptless: each
 * control is a plain <label> bound to the adjacent chapter's radio, same
 * technique as the nav. First chapter omits Previous; last omits Next. The
 * class attribute precedes `for` so these never collide with the nav's
 * `<label for="cN">` markup shape.
 */
function pager(index: number, count: number): string {
  const prev =
    index > 0 ? `<label class="pager-prev" for="c${index - 1}">← Previous</label>` : "";
  const next =
    index < count - 1
      ? `<label class="pager-next" for="c${index + 1}">Next →</label>`
      : "";
  if (prev === "" && next === "") return "";
  return `<footer class="pager">${prev}${next}</footer>`;
}

// ---------------------------------------------------------------------------
// Stylesheet (light theme only — user mandate; no dark scheme in v0.1)
// ---------------------------------------------------------------------------

function stylesheet(chapterCount: number): string {
  const reveal: string[] = [];
  for (let i = 0; i < chapterCount; i++) {
    reveal.push(`#c${i}:checked~#p${i}{display:block}`);
    reveal.push(
      `#c${i}:checked~nav label[for="c${i}"]{color:#1d4ed8;border-color:#1d4ed8;` +
        `background:#eff6ff;font-weight:600}`
    );
    reveal.push(
      `#c${i}:focus-visible~nav label[for="c${i}"]{outline:2px solid #1d4ed8;outline-offset:2px}`
    );
  }
  return [
    // Reset + base. System fonts, generous whitespace, neutral grays, one accent.
    `*,*::before,*::after{box-sizing:border-box}`,
    `body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;` +
      `color:#1f2937;background:#ffffff;line-height:1.6}`,
    `header,main{max-width:52rem;margin:0 auto;padding:0 1.25rem}`,
    // Long repo-controlled tokens (paths, identifiers) must wrap so 320px
    // never scrolls horizontally.
    `h1,h2,h3,p,label,summary,figcaption{overflow-wrap:anywhere}`,
    // Skip link: clipped off-screen but focusable; revealed on focus.
    `.skip-link{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;` +
      `clip:rect(0 0 0 0);clip-path:inset(50%)}`,
    `.skip-link:focus{position:fixed;top:0.5rem;left:0.5rem;width:auto;height:auto;margin:0;` +
      `overflow:visible;clip:auto;clip-path:none;background:#ffffff;color:#1d4ed8;` +
      `padding:0.5rem 1rem;border:1px solid #1d4ed8;border-radius:4px}`,
    // Masthead: small eyebrow, medium repo name, small muted subtitle with
    // the shortened revisions as secondary evidence.
    `header{padding-top:2.5rem}`,
    `.masthead-kicker{margin:0 0 0.25rem;font-size:0.6875rem;font-weight:600;` +
      `letter-spacing:0.08em;text-transform:uppercase;color:#6b7280}`,
    `h1{font-size:1.125rem;font-weight:600;margin:0}`,
    `.subtitle{color:#6b7280;font-size:0.8125rem;margin:0.375rem 0 0}`,
    `.subtitle .rev{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;` +
      `font-size:0.75rem;color:#9ca3af;overflow-wrap:anywhere}`,
    // Type scale: large chapter heading > medium masthead > small metadata.
    `h2{font-size:1.5rem;font-weight:600;letter-spacing:-0.015em;margin:2.5rem 0 0.25rem}`,
    `.chapter-sub{color:#6b7280;font-size:1rem;margin:0.25rem 0 1.75rem}`,
    `h3{font-size:0.75rem;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;` +
      `color:#6b7280;margin:2rem 0 0.75rem}`,
    `p{margin:0.75rem 0}`,
    `.muted{color:#6b7280}`,
    `code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.875em;` +
      `background:#f9fafb;border:1px solid #e5e7eb;border-radius:4px;padding:0.1em 0.35em;overflow-wrap:anywhere}`,
    `ul,ol{margin:0.5rem 0;padding-left:1.5rem}`,
    `li{margin:0.25rem 0;overflow-wrap:anywhere}`,
    // Provenance markers: glyph + text + title attribute; never colour-only.
    `.badge{display:inline-block;font-size:0.6875rem;line-height:1.7;color:#6b7280;` +
      `border:1px solid #d1d5db;border-radius:999px;padding:0 0.5rem;vertical-align:middle}`,
    `.prov{color:#6b7280;font-size:0.875em}`,
    // Diagram-first: figures get room and dominate the chapter.
    // overflow-x:auto keeps an oversized diagram scrolling inside its own
    // figure instead of widening the page at 320px.
    `figure.diagram{margin:1.5rem 0;padding:1rem;border:1px solid #e5e7eb;border-radius:8px;` +
      `background:#ffffff;overflow-x:auto}`,
    `figure.diagram svg{display:block;max-width:100%;height:auto}`,
    `figure.diagram-placeholder{display:flex;align-items:center;justify-content:center;min-height:8rem;background:#f9fafb}`,
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
    // Evidence stays collapsed and quiet.
    `details{margin:1.5rem 0;border:1px solid #e5e7eb;border-radius:8px;padding:0.5rem 1rem}`,
    `summary{cursor:pointer;color:#6b7280}`,
    `ul.evidence{list-style:none;padding-left:0}`,
    // Housekeeping commits: quieter than regular evidence details.
    `details.housekeeping{border:none;border-radius:0;padding:0;margin:0.25rem 0 0}`,
    `details.housekeeping summary{font-size:0.8125rem}`,
    // Scriptless chapter switching: visually hidden but focusable radios.
    `input[name="chapter"]{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;` +
      `clip:rect(0 0 0 0);clip-path:inset(50%)}`,
    // Navigation: two labelled clusters of compact pills, clearly separated
    // from the content below.
    `nav{display:flex;flex-direction:column;gap:1rem;margin:1.5rem 0 1rem;` +
      `border-bottom:1px solid #e5e7eb;padding-bottom:1.5rem}`,
    `.nav-group-label{margin:0 0 0.5rem;font-size:0.6875rem;font-weight:600;` +
      `letter-spacing:0.08em;text-transform:uppercase;color:#6b7280}`,
    `.nav-pills{display:flex;flex-wrap:wrap;gap:0.375rem}`,
    `nav label{cursor:pointer;color:#4b5563;font-size:0.8125rem;line-height:1.5;` +
      `padding:0.25rem 0.75rem;border:1px solid #e5e7eb;border-radius:999px;background:#ffffff}`,
    `nav label:hover{color:#1f2937;border-color:#d1d5db;background:#f9fafb}`,
    // Content: readable measure, clear separation from the nav.
    `main > section{display:none;max-width:70ch;padding-bottom:4rem}`,
    // Previous/Next: quiet bordered labels at the chapter foot; Next hugs the
    // right edge even when Previous is absent (first chapter).
    `.pager{display:flex;gap:0.75rem;margin-top:2.5rem;border-top:1px solid #e5e7eb;padding-top:1rem}`,
    `.pager label{cursor:pointer;color:#6b7280;border:1px solid #e5e7eb;border-radius:6px;padding:0.375rem 0.875rem}`,
    `.pager label:hover{color:#1f2937;border-color:#d1d5db}`,
    `.pager-next{margin-left:auto}`,
    ...reveal
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------

const CSP_CONTENT = "default-src 'none'; style-src 'unsafe-inline'; img-src data:;";

function navCluster(groupLabel: string, items: { index: number; label: string }[]): string {
  if (items.length === 0) return "";
  const pills = items
    .map((item) => `<label for="c${item.index}">${escHtml(item.label)}</label>`)
    .join("");
  return (
    `<div class="nav-group"><p class="nav-group-label">${escHtml(groupLabel)}</p>` +
    `<div class="nav-pills">${pills}</div></div>`
  );
}

/**
 * Render the change book as one self-contained HTML document string.
 * Pure and deterministic: same manifests (and options) in, byte identical
 * document out.
 */
export function renderChangeBook(
  book: BookManifest,
  change: ChangeManifest,
  options: RenderOptions = {}
): string {
  const meaningful = change.changeUnits.filter((unit) => !unit.grouped);

  const chapters: RenderedChapter[] = [
    overviewChapter(change, meaningful),
    ...meaningful.map((unit, i) => changeUnitChapter(unit, i + 1, change, options)),
    ...book.chapters.map((chapter) => bookChapter(chapter, change, options))
  ];

  const inputs = chapters
    .map(
      (_, i) =>
        `<input type="radio" name="chapter" id="c${i}"${i === 0 ? " checked" : ""}>`
    )
    .join("");
  const withIndex = chapters.map((chapter, index) => ({
    index,
    label: chapter.navLabel,
    group: chapter.group
  }));
  const nav =
    `<nav aria-label="Chapters">` +
    navCluster("This change", withIndex.filter((c) => c.group === "change")) +
    navCluster("The book", withIndex.filter((c) => c.group === "book")) +
    `</nav>`;
  const sections = chapters
    .map(
      (chapter, i) =>
        `<section id="p${i}">${chapter.body}${pager(i, chapters.length)}</section>`
    )
    .join("");

  const displayName = options.repoName ?? change.repository.name;
  const title = escHtml(`${displayName} — change book`);
  const count = meaningful.length;
  const subtitle =
    `${count} change${count === 1 ? "" : "s"} · ` +
    `<span class="rev">${escHtml(shortRev(change.baseRevision))}</span> → ` +
    `<span class="rev">${escHtml(shortRev(change.headRevision))}</span>`;

  return (
    `<!doctype html>` +
    `<html lang="en">` +
    `<head>` +
    `<meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${CSP_CONTENT}">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${title}</title>` +
    `<style>${stylesheet(chapters.length)}</style>` +
    `</head>` +
    `<body>` +
    `<a class="skip-link" href="#main">Skip to content</a>` +
    `<header class="masthead">` +
    `<p class="masthead-kicker">Change book</p>` +
    `<h1>${escHtml(displayName)}</h1>` +
    `<p class="subtitle">${subtitle}</p>` +
    `</header>` +
    `<main id="main">` +
    inputs +
    nav +
    sections +
    `</main>` +
    `</body>` +
    `</html>`
  );
}
