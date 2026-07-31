/**
 * Left sidebar navigation (dashboard shell).
 *
 * OWNER: parallel agent A. See dashboard-contract.md.
 * Class prefix: `sb-`. All CSS for this module lives in `sidebarCss`.
 *
 * Target UX (design doc "Reader experience" §1): sticky left sidebar with
 * the repo wordmark on top and vertical view tabs (Home / Overview /
 * Architecture / How it works / More) with a clear active state; under
 * ~736px it collapses to a horizontally scrollable top tab row; no page
 * overflow at 320px. Light theme only. No JavaScript.
 */

import { escAttr, escHtml } from "./escape.js";
import type { ViewTab } from "./dashboardTypes.js";

/** All sidebar CSS. Concatenated into the single <style> by the integrator. */
export const sidebarCss = `
/* --- sidebar (sb-) — stub, agent A replaces --- */
.sb-nav { position: sticky; top: 0; }
`;

/**
 * Render the sidebar: wordmark, then one tab per view; the tab whose id
 * equals `activeId` carries the active class and aria-current="page".
 * `repoName` (hostile input) is the wordmark text; omitted → no wordmark.
 * Pure string builder; deterministic; every repo string escaped.
 */
export function renderSidebar(
  views: readonly ViewTab[],
  activeId: string,
  repoName?: string
): string {
  const wordmark =
    repoName === undefined
      ? ""
      : `<p class="sb-wordmark">${escHtml(repoName)}</p>`;
  const tabs = views
    .map((view) => {
      const active = view.id === activeId;
      return (
        `<li class="sb-item${active ? " sb-item-active" : ""}">` +
        `<a class="sb-tab" href="${escAttr(view.href)}"` +
        `${active ? ` aria-current="page"` : ""}>${escHtml(view.label)}</a></li>`
      );
    })
    .join("");
  return (
    `<nav class="sb-nav" aria-label="Views">` +
    wordmark +
    `<ul class="sb-tabs">${tabs}</ul>` +
    `</nav>`
  );
}
