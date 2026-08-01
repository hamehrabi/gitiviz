/**
 * One commit's own page, opened from a card via anchor + :target.
 *
 * OWNER: parallel agent C. See dashboard-contract.md.
 * Class prefix: `cp-`. All CSS for this module lives in `commitPageCss`.
 *
 * Target UX (design doc "Reader experience" §3), in document order:
 *   1. meta row — type tag + short sha (quiet evidence)
 *   2. human title (◇ prov mark when narrated)
 *   3. one sentence of purpose
 *   4. Before / After as two short labeled rows
 *   5. the before→after diagram (`diagramSvg` from the existing SVG
 *      engine — this parameter is the clean insertion point for a future
 *      Mermaid export adapter)
 *   6. collapsed "Unchanged: N components" (omitted when N = 0)
 *   7. prominent "← All changes" back link (href="#": clearing the
 *      fragment un-targets the page, so Home — the default view — returns
 *      and browser Back still works)
 *   8. technical evidence, collapsed at the bottom
 *
 * Ruthless cognitive-load budget: at most 8 direct children on the root
 * before anything folds (enforced by commitPage.test.ts). Visibility
 * (only the :target page shows) is the INTEGRATOR's shell CSS, not ours —
 * this module only guarantees `id={anchorId}` on its root. Light theme
 * only. Zero JavaScript. Pure and deterministic; every repo-derived
 * string passes through escape.ts at the point of output.
 */

import type { EvidenceAnchor } from "@gitiviz/schema";
import { escAttr, escHtml } from "./escape.js";
import type { CommitPageModel } from "./dashboardTypes.js";

// ---------------------------------------------------------------------------
// Provenance marks (glyph + title text — colour never the only carrier).
// `prov` is the shared primitive styled by the integrator; reused, not restyled.
// ---------------------------------------------------------------------------

const INFERRED_MARK =
  `<span class="prov" title="AI interpretation: narrated title, not a derived fact">◇</span>`;

const DERIVED_MARK =
  `<span class="prov" title="Derived deterministically from the repository">✓</span>`;

const MONO =
  `ui-monospace,SFMono-Regular,Menlo,Consolas,monospace`;

// ---------------------------------------------------------------------------
// CSS (concatenated into the single <style> by the integrator — never emit
// a <style> tag here). Only `.cp-*` selectors; light theme only.
// ---------------------------------------------------------------------------

/** All commit-page CSS. Concatenated into the single <style> by the integrator. */
export const commitPageCss = `
/* --- commit page (cp-) --- */
.cp-page{max-width:44rem}
.cp-meta{display:flex;align-items:center;gap:0.5rem;margin:0 0 0.75rem}
.cp-tag{font-size:0.6875rem;font-weight:600;line-height:1.7;padding:0 0.5rem;border-radius:999px;color:#4b5563;background:#f3f4f6;border:1px solid #e5e7eb}
.cp-tag-feature{color:#1d4ed8;background:#eff6ff;border-color:#bfdbfe}
.cp-sha{font-family:${MONO};font-size:0.75rem;color:#9ca3af;overflow-wrap:anywhere}
.cp-title{margin:0 0 0.25rem}
.cp-purpose{color:#6b7280;font-size:1rem;margin:0.25rem 0 1.5rem}
.cp-beforeafter{margin:1.25rem 0;border:1px solid #e5e7eb;border-radius:8px;background:#ffffff}
.cp-row{display:flex;gap:0.75rem;padding:0.625rem 0.875rem;margin:0}
.cp-row+.cp-row{border-top:1px solid #f3f4f6}
.cp-row dt{flex-shrink:0;width:4.5rem;font-size:0.6875rem;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#6b7280;padding-top:0.3em}
.cp-row-after dt{color:#1d4ed8}
.cp-row dd{margin:0;overflow-wrap:anywhere}
.cp-not-narrated{color:#9ca3af}
.cp-diagram{margin:1.5rem 0;padding:1rem;border:1px solid #e5e7eb;border-radius:8px;background:#ffffff;overflow-x:auto}
.cp-diagram svg{display:block;max-width:100%;height:auto}
.cp-diagram figcaption{margin:0.75rem 0 0;font-size:0.8125rem;color:#6b7280}
.cp-no-diagram{display:flex;align-items:center;justify-content:center;min-height:6rem;margin:0;color:#6b7280;background:#f9fafb;border-radius:4px}
.cp-source{margin:0.75rem 0 0}
.cp-source>summary{cursor:pointer;color:#6b7280;font-size:0.8125rem}
.cp-source pre{margin:0.5rem 0 0;padding:0.75rem;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;overflow-x:auto;font-size:0.75rem;line-height:1.5}
.cp-source code{font-family:${MONO};background:transparent;border:none;padding:0}
.cp-ev-figure{margin:0.75rem 0;padding:0.5rem;border:1px solid #e5e7eb;border-radius:6px;background:#ffffff;overflow-x:auto}
.cp-ev-figure svg{display:block;max-width:100%;height:auto}
.cp-unchanged,.cp-evidence{margin:1rem 0;border:1px solid #e5e7eb;border-radius:8px;padding:0.5rem 1rem}
.cp-unchanged>summary,.cp-evidence>summary{cursor:pointer;color:#6b7280;font-size:0.875rem;overflow-wrap:anywhere}
.cp-unchanged p{margin:0.5rem 0;font-size:0.875rem;color:#6b7280}
.cp-back{margin:1.5rem 0}
.cp-back-link{display:inline-block;color:#1d4ed8;text-decoration:none;font-weight:600;border:1px solid #bfdbfe;background:#eff6ff;border-radius:6px;padding:0.4375rem 0.875rem}
.cp-back-link:hover{border-color:#1d4ed8}
.cp-back-link:focus-visible{outline:2px solid #1d4ed8;outline-offset:2px}
.cp-ev-title{margin:0.75rem 0 0.25rem;overflow-wrap:anywhere}
.cp-ev-title code{font-family:${MONO};font-size:0.8125rem;background:#f9fafb;border:1px solid #e5e7eb;border-radius:4px;padding:0.1em 0.35em;overflow-wrap:anywhere}
.cp-ev-list{list-style:none;margin:0.5rem 0 0.75rem;padding:0}
.cp-ev-list li{margin:0.375rem 0;overflow-wrap:anywhere}
.cp-ev-list code{font-family:${MONO};font-size:0.8125rem;background:#f9fafb;border:1px solid #e5e7eb;border-radius:4px;padding:0.1em 0.35em;overflow-wrap:anywhere}
.cp-ev-muted{color:#6b7280}
.cp-ev-empty{margin:0.5rem 0;color:#6b7280;font-size:0.875rem}
@media (max-width:479px){.cp-row{flex-direction:column;gap:0.125rem}.cp-row dt{width:auto;padding-top:0}}
`;

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

/** Type tag + short sha. `type` is a closed set (safe in class names). */
function metaRow(unit: CommitPageModel): string {
  const sha = unit.shortSha
    ? `<code class="cp-sha">${escHtml(unit.shortSha)}</code>`
    : "";
  return (
    `<p class="cp-meta">` +
    `<span class="cp-tag cp-tag-${unit.type}">${unit.type}</span>` +
    sha +
    `</p>`
  );
}

/** One Before/After row; null narration renders a quiet placeholder. */
function beforeAfterRow(
  slot: "before" | "after",
  label: string,
  text: string | null
): string {
  const body =
    text === null
      ? `<span class="cp-not-narrated">Not narrated yet.</span>`
      : escHtml(text);
  return (
    `<div class="cp-row cp-row-${slot}"><dt>${label}</dt>` +
    `<dd>${body}</dd></div>`
  );
}

/**
 * The diagram slot. `diagramSvg` is trusted, pre-escaped SVG markup —
 * either prerendered Mermaid or the built-in story engine — inserted
 * verbatim; null renders a quiet placeholder. The optional extras add the
 * collapsed "Diagram source" fold (escaped mermaid text) and the honest
 * fallback note, both INSIDE the figure so the page's child budget holds.
 */
function diagramFigure(
  diagramSvg: string | null,
  extras: CommitPageDiagramExtras
): string {
  const body =
    diagramSvg ?? `<p class="cp-no-diagram">No diagram for this change.</p>`;
  const source =
    extras.sourceText == null
      ? ""
      : `<details class="cp-source"><summary>Diagram source</summary>` +
        `<pre><code>${escHtml(extras.sourceText)}</code></pre></details>`;
  const note =
    extras.fallbackNote == null
      ? ""
      : `<figcaption>${escHtml(extras.fallbackNote)}</figcaption>`;
  return `<figure class="cp-diagram">${body}${source}${note}</figure>`;
}

/** Collapsed "Unchanged: N components" — omitted entirely when N is 0. */
function unchangedFold(count: number): string {
  if (count === 0) return "";
  const noun = count === 1 ? "component" : "components";
  return (
    `<details class="cp-unchanged">` +
    `<summary>Unchanged: ${count} ${noun}</summary>` +
    `<p>${count} ${noun} in the system ${count === 1 ? "was" : "were"} ` +
    `not touched by this change.</p>` +
    `</details>`
  );
}

function anchorLine(anchor: EvidenceAnchor): string {
  let text = escHtml(anchor.path);
  if (anchor.range) {
    text +=
      ` <span class="cp-ev-muted">lines ` +
      `${anchor.range.startLine}–${anchor.range.endLine}</span>`;
  }
  if (anchor.symbol) {
    text += ` <span class="cp-ev-muted">· ${escHtml(anchor.symbol)}</span>`;
  }
  return `<li>${DERIVED_MARK} <code>${text}</code></li>`;
}

/**
 * Technical evidence, collapsed at the bottom: raw subject, the full
 * unit-scoped entity graph (the ONLY place it may appear), commits, anchors.
 */
function evidenceFold(unit: CommitPageModel, extras: CommitPageDiagramExtras): string {
  const commits = (unit.unit.commits ?? []).map(
    (sha) =>
      `<li>${DERIVED_MARK} Commit ` +
      `<code title="${escAttr(sha)}">${escHtml(sha.slice(0, 7))}</code></li>`
  );
  const anchors = (unit.unit.evidence ?? []).map(anchorLine);
  const lines = [...commits, ...anchors];
  const list =
    lines.length === 0
      ? `<p class="cp-ev-empty">No recorded evidence for this change.</p>`
      : `<ul class="cp-ev-list">${lines.join("")}</ul>`;
  const graph =
    extras.evidenceSvg == null
      ? ""
      : `<figure class="cp-ev-figure">${extras.evidenceSvg}</figure>`;
  return (
    `<details class="cp-evidence">` +
    `<summary>Technical evidence</summary>` +
    `<p class="cp-ev-title">${DERIVED_MARK} ` +
    `<code>${escHtml(unit.unit.technicalTitle)}</code></p>` +
    graph +
    list +
    `</details>`
  );
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Optional diagram extras for one commit page. */
export interface CommitPageDiagramExtras {
  /** Mermaid text for the collapsed "Diagram source" fold in the figure. */
  sourceText?: string | null;
  /** Honest note when the hero diagram used the built-in fallback engine. */
  fallbackNote?: string | null;
  /** Full unit graph SVG — rendered ONLY inside the Technical evidence fold. */
  evidenceSvg?: string | null;
}

/**
 * Render one commit page. `diagramSvg` is trusted, pre-escaped SVG markup
 * (prerendered Mermaid or the built-in story engine), inserted verbatim;
 * null renders a quiet placeholder. Pure; deterministic; every repo-derived
 * string escaped.
 */
export function renderCommitPage(
  unit: CommitPageModel,
  diagramSvg: string | null,
  extras: CommitPageDiagramExtras = {}
): string {
  const anchorId = escAttr(unit.anchorId);
  const mark = unit.titleInferred ? ` ${INFERRED_MARK}` : "";
  const purpose = unit.purpose
    ? `<p class="cp-purpose">${escHtml(unit.purpose)}</p>`
    : "";
  return (
    `<section class="cp-page" id="${anchorId}" aria-labelledby="${anchorId}-title">` +
    metaRow(unit) +
    `<h2 class="cp-title" id="${anchorId}-title">${escHtml(unit.title)}${mark}</h2>` +
    purpose +
    `<dl class="cp-beforeafter">` +
    beforeAfterRow("before", "Before", unit.before) +
    beforeAfterRow("after", "After", unit.after) +
    `</dl>` +
    diagramFigure(diagramSvg, extras) +
    unchangedFold(unit.unchangedCount) +
    `<p class="cp-back"><a class="cp-back-link" href="#">← All changes</a></p>` +
    evidenceFold(unit, extras) +
    `</section>`
  );
}
