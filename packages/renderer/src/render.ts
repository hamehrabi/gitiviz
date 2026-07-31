/**
 * HTML shell renderer — one self-contained, scriptless, offline document.
 *
 * Mandates (user + design doc):
 *   - Clean, standard, low cognitive load. LIGHT THEME ONLY in v0.1: system
 *     font stack, generous whitespace, neutral grays + one accent. No
 *     gradients, no badges, no dashboard clutter, no dark scheme.
 *   - Zero JavaScript. The CSP bans scripts entirely; chapter switching is
 *     the pure-CSS radio/label technique (native elements, keyboard-safe).
 *   - Diagram-first: diagrams are the dominant content of each chapter. They
 *     are compiled by the diagram module (Task 15b) and injected through the
 *     `renderDiagram` callback; until then a quiet placeholder renders.
 *   - Every repo-controlled string goes through escape.ts. Element ids and
 *     CSS selectors are generated locally (`c0`/`p0`…), never repo-derived.
 */

import type {
  BookChapter,
  BookManifest,
  ChangeManifest,
  ChangeState,
  ChangeUnit,
  Entity,
  EvidenceAnchor,
  Relationship
} from "@gitiviz/schema";
import { escAttr, escHtml } from "./escape.js";

// ---------------------------------------------------------------------------
// Diagram insertion point (implemented by Task 15b's diagram module)
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
  return `<li><code>${text}</code></li>`;
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

function timeline(units: ChangeUnit[]): string {
  const items = units
    .map((unit) => {
      let entry = escHtml(unit.technicalTitle);
      if (unit.grouped) {
        const reason = unit.groupedReason ? escHtml(unit.groupedReason) : "grouped";
        entry += ` <span class="muted">(${reason})</span>`;
      }
      return `<li>${entry}</li>`;
    })
    .join("");
  return `<ol class="timeline">${items}</ol>`;
}

// ---------------------------------------------------------------------------
// Chapter bodies
// ---------------------------------------------------------------------------

interface RenderedChapter {
  /** Nav label, raw (escaped at emit time). */
  navLabel: string;
  /** Inner HTML of the chapter's <section>. */
  body: string;
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
    `<h2>Overview</h2>` +
    `<p>${escHtml(change.repository.name)}: comparing ` +
    `<code>${escHtml(shortRev(change.baseRevision))}</code> to ` +
    `<code>${escHtml(shortRev(change.headRevision))}</code> — ${countText}.</p>` +
    `<h3>Commit timeline</h3>` +
    timeline(change.changeUnits) +
    limitations;
  return { navLabel: "Overview", body };
}

function changeUnitChapter(
  unit: ChangeUnit,
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

  const caption = unit.summary ?? unit.technicalTitle;
  const figure = diagramFigure(
    { kind: "change", entities, relationships, changeUnit: unit },
    options.renderDiagram,
    caption
  );

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
  if (unit.provenance === "inferred") {
    narration += `<p class="muted">◇ AI interpretation</p>`;
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

  const body =
    `<h2>${escHtml(unitTitle(unit))}</h2>` +
    figure +
    narration +
    unchanged +
    evidenceDetails(anchors);
  return { navLabel: unitTitle(unit), body };
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
  const heading = `<h2>${escHtml(chapter.title)}</h2>`;
  if (chapter.status === "not-written") {
    return {
      navLabel: chapter.title,
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
  return { navLabel: chapter.title, body };
}

// ---------------------------------------------------------------------------
// Stylesheet (light theme only — user mandate; no dark scheme in v0.1)
// ---------------------------------------------------------------------------

function stylesheet(chapterCount: number): string {
  const reveal: string[] = [];
  for (let i = 0; i < chapterCount; i++) {
    reveal.push(`#c${i}:checked~#p${i}{display:block}`);
    reveal.push(
      `#c${i}:checked~nav label[for="c${i}"]{color:#1d4ed8;border-color:#1d4ed8}`
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
    `header{padding-top:2.5rem}`,
    `h1{font-size:1.5rem;font-weight:600;margin:0 0 0.25rem}`,
    `h2{font-size:1.25rem;font-weight:600;margin:2rem 0 0.75rem}`,
    `h3{font-size:1rem;font-weight:600;margin:1.5rem 0 0.5rem}`,
    `p{margin:0.75rem 0}`,
    `.muted{color:#6b7280}`,
    `.subtitle{color:#6b7280;margin:0 0 1.5rem}`,
    `code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.875em;` +
      `background:#f9fafb;border:1px solid #e5e7eb;border-radius:4px;padding:0.1em 0.35em;overflow-wrap:anywhere}`,
    `ul,ol{margin:0.5rem 0;padding-left:1.5rem}`,
    `li{margin:0.25rem 0;overflow-wrap:anywhere}`,
    // Diagram-first: figures get room and dominate the chapter.
    `figure.diagram{margin:1.5rem 0;padding:1rem;border:1px solid #e5e7eb;border-radius:8px;background:#ffffff}`,
    `figure.diagram svg{display:block;max-width:100%;height:auto}`,
    `figure.diagram-placeholder{display:flex;align-items:center;justify-content:center;min-height:8rem;background:#f9fafb}`,
    `.caption{margin:1.5rem 0 0.5rem;font-size:1.0625rem}`,
    // Evidence stays collapsed and quiet.
    `details{margin:1.5rem 0;border:1px solid #e5e7eb;border-radius:8px;padding:0.5rem 1rem}`,
    `summary{cursor:pointer;color:#6b7280}`,
    `ul.evidence{list-style:none;padding-left:0}`,
    // Scriptless chapter switching: visually hidden but focusable radios.
    `input[name="chapter"]{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;` +
      `clip:rect(0 0 0 0);clip-path:inset(50%)}`,
    `nav{display:flex;flex-wrap:wrap;gap:0.25rem 1rem;margin:1rem 0 1.5rem;` +
      `border-bottom:1px solid #e5e7eb;padding-bottom:0.75rem}`,
    `nav label{cursor:pointer;color:#6b7280;padding:0.25rem 0;border-bottom:2px solid transparent}`,
    `nav label:hover{color:#1f2937}`,
    `main > section{display:none;padding-bottom:3rem}`,
    ...reveal
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------

const CSP_CONTENT = "default-src 'none'; style-src 'unsafe-inline'; img-src data:;";

/**
 * Render the change book as one self-contained HTML document string.
 * Pure and deterministic: same manifests (and diagram callback) in, byte
 * identical document out.
 */
export function renderChangeBook(
  book: BookManifest,
  change: ChangeManifest,
  options: RenderOptions = {}
): string {
  const meaningful = change.changeUnits.filter((unit) => !unit.grouped);

  const chapters: RenderedChapter[] = [
    overviewChapter(change, meaningful),
    ...meaningful.map((unit) => changeUnitChapter(unit, change, options)),
    ...book.chapters.map((chapter) => bookChapter(chapter, change, options))
  ];

  const inputs = chapters
    .map(
      (_, i) =>
        `<input type="radio" name="chapter" id="c${i}"${i === 0 ? " checked" : ""}>`
    )
    .join("");
  const nav =
    `<nav aria-label="Chapters">` +
    chapters
      .map((chapter, i) => `<label for="c${i}">${escHtml(chapter.navLabel)}</label>`)
      .join("") +
    `</nav>`;
  const sections = chapters
    .map((chapter, i) => `<section id="p${i}">${chapter.body}</section>`)
    .join("");

  const title = escHtml(`${change.repository.name} — change book`);

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
    `<header><h1>${escHtml(change.repository.name)}</h1>` +
    `<p class="subtitle">${escHtml(shortRev(change.baseRevision))} → ${escHtml(
      shortRev(change.headRevision)
    )}</p></header>` +
    `<main>` +
    inputs +
    nav +
    sections +
    `</main>` +
    `</body>` +
    `</html>`
  );
}
