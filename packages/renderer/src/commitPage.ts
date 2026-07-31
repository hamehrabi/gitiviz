/**
 * One commit's own page, opened from a card via anchor + :target.
 *
 * OWNER: parallel agent C. See dashboard-contract.md.
 * Class prefix: `cp-`. All CSS for this module lives in `commitPageCss`.
 *
 * Target UX (design doc "Reader experience" §3): in order — human title;
 * one sentence of purpose; Before and After as two short labeled rows;
 * the before→after diagram (`diagramSvg` from the existing SVG engine —
 * this parameter is the clean insertion point for a future Mermaid export
 * adapter); collapsed "Unchanged: N"; a prominent "← All changes"
 * back link; technical evidence collapsed at the bottom. Ruthless budget:
 * max ~8 visible elements before folds. Visibility (only the :target page
 * shows; home otherwise) is implemented by the INTEGRATOR's shell CSS,
 * not here — this module only guarantees `id={anchorId}` on its root.
 * Light theme only. No JavaScript.
 */

import { escAttr, escHtml } from "./escape.js";
import type { CommitPageModel } from "./dashboardTypes.js";

/** All commit-page CSS. Concatenated into the single <style> by the integrator. */
export const commitPageCss = `
/* --- commit page (cp-) — stub, agent C replaces --- */
.cp-page { max-width: 48rem; }
`;

/**
 * Render one commit page. `diagramSvg` is trusted, pre-escaped SVG markup
 * from the diagram module, inserted verbatim; null renders a quiet
 * placeholder. Pure; deterministic; every repo-derived string escaped.
 */
export function renderCommitPage(
  unit: CommitPageModel,
  diagramSvg: string | null
): string {
  const mark = unit.titleInferred
    ? ` <span class="prov" title="AI interpretation: narrated title, not a derived fact">◇</span>`
    : "";
  const purpose = unit.purpose
    ? `<p class="cp-purpose">${escHtml(unit.purpose)}</p>`
    : "";
  const before = unit.before ?? "Not narrated yet.";
  const after = unit.after ?? "Not narrated yet.";
  const diagram = diagramSvg ?? `<p class="cp-no-diagram">No diagram for this change.</p>`;
  return (
    `<article class="cp-page" id="${escAttr(unit.anchorId)}">` +
    `<p class="cp-back"><a class="cp-back-link" href="#home">← All changes</a></p>` +
    `<h2 class="cp-title">${escHtml(unit.title)}${mark}</h2>` +
    purpose +
    `<dl class="cp-beforeafter">` +
    `<div class="cp-row"><dt>Before</dt><dd>${escHtml(before)}</dd></div>` +
    `<div class="cp-row"><dt>After</dt><dd>${escHtml(after)}</dd></div>` +
    `</dl>` +
    `<figure class="cp-diagram">${diagram}</figure>` +
    `<details class="cp-unchanged"><summary>Unchanged: ${unit.unchangedCount}</summary></details>` +
    `<details class="cp-evidence"><summary>Technical evidence</summary></details>` +
    `</article>`
  );
}
