/**
 * Home view: CSS-only filter chips + commit cards grid.
 *
 * OWNER: parallel agent B. See dashboard-contract.md.
 * Class prefix: `cd-`. All CSS for this module lives in `cardsCss`.
 *
 * Target UX (design doc "Reader experience" §2): filter chips above the
 * grid — "All" plus the commit types present — implemented with hidden
 * radio inputs + sibling selectors (no JavaScript). One card per change
 * unit: human title (◇ mark when narrated), one-line summary, short sha,
 * type tag, chapter chips, clickable affordance (border, hover shadow,
 * arrow). Cards are anchors onto each commit's own page. Light theme only,
 * keyboard accessible, no overflow at 320px.
 */

import { escAttr, escHtml } from "./escape.js";
import type { CardModel } from "./dashboardTypes.js";
import type { CommitType } from "./render.js";

/** All cards/chips CSS. Concatenated into the single <style> by the integrator. */
export const cardsCss = `
/* --- home cards + filter chips (cd-) — stub, agent B replaces --- */
.cd-grid { display: grid; gap: 1rem; }
`;

/**
 * Render the CSS-only filter chip row: an "All" chip plus one chip per
 * commit type present, in the order given. Radio inputs named "cd-filter"
 * live at the dashboard root so sibling selectors in `cardsCss` can show/
 * hide cards. Pure; deterministic. `types` is a closed set (CommitType) —
 * values are safe in ids and class names.
 */
export function renderFilterChips(types: readonly CommitType[]): string {
  const chips = types
    .map(
      (type) =>
        `<input type="radio" name="cd-filter" id="cd-filter-${type}" class="cd-filter-input">` +
        `<label class="cd-chip" for="cd-filter-${type}">${escHtml(type)}</label>`
    )
    .join("");
  return (
    `<div class="cd-filters" role="group" aria-label="Filter by type">` +
    `<input type="radio" name="cd-filter" id="cd-filter-all" class="cd-filter-input" checked>` +
    `<label class="cd-chip" for="cd-filter-all">All</label>` +
    chips +
    `</div>`
  );
}

/**
 * Render the commit cards grid, one anchor-card per model, in the order
 * given (index order = manifest order). Pure; deterministic; every
 * repo-derived string escaped.
 */
export function renderCardsGrid(units: readonly CardModel[]): string {
  const cards = units
    .map((card) => {
      const mark = card.titleInferred
        ? ` <span class="prov" title="AI interpretation: narrated title, not a derived fact">◇</span>`
        : "";
      const sha = card.shortSha
        ? `<code class="cd-sha">${escHtml(card.shortSha)}</code>`
        : "";
      const summary = card.summary
        ? `<p class="cd-summary">${escHtml(card.summary)}</p>`
        : "";
      const chips = card.chapters
        .map((chip) => `<span class="cd-chapter">${escHtml(chip.label)}</span>`)
        .join("");
      return (
        `<a class="cd-card cd-type-${card.type}" href="${escAttr(card.href)}">` +
        `<p class="cd-meta"><span class="cd-tag cd-tag-${card.type}">${card.type}</span>${sha}` +
        `<span class="cd-arrow" aria-hidden="true">→</span></p>` +
        `<h3 class="cd-title">${escHtml(card.title)}${mark}</h3>` +
        summary +
        (chips === "" ? "" : `<p class="cd-chapters">${chips}</p>`) +
        `</a>`
      );
    })
    .join("");
  return `<div class="cd-grid">${cards}</div>`;
}
