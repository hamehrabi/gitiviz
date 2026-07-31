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
 *
 * Navigation mechanism: plain anchors to view fragments ("#home", …).
 * Show/hide of the view sections via `:target` is the INTEGRATOR's CSS;
 * this module only guarantees the hrefs (dashboard-contract.md §:target).
 */

import { escAttr, escHtml } from "./escape.js";
import type { ViewTab } from "./dashboardTypes.js";

/** All sidebar CSS. Concatenated into the single <style> by the integrator. */
export const sidebarCss = [
  /* --- sidebar (sb-) — sticky left column, collapses under 736px --- */
  `.sb-nav{position:sticky;top:0;align-self:flex-start;box-sizing:border-box;` +
    `flex:0 0 auto;width:13.5rem;max-height:100vh;overflow-y:auto;` +
    `padding:1.5rem 0.875rem 1.5rem 1rem;background:#ffffff;` +
    `border-right:1px solid #e5e7eb}`,
  `.sb-wordmark{margin:0 0 1.5rem;padding:0 0.625rem;font-size:0.9375rem;` +
    `font-weight:700;letter-spacing:0.01em;color:#111827;line-height:1.3;` +
    `overflow-wrap:anywhere}`,
  /* quiet accent tick under the wordmark — the sidebar's one flourish */
  `.sb-wordmark::after{content:"";display:block;width:1.75rem;height:3px;` +
    `margin-top:0.5rem;border-radius:2px;background:#1d4ed8}`,
  `.sb-tabs{list-style:none;margin:0;padding:0;display:flex;` +
    `flex-direction:column;gap:0.125rem}`,
  `.sb-item{margin:0}`,
  `.sb-tab{display:block;padding:0.4375rem 0.625rem;border-radius:6px;` +
    `border-left:3px solid transparent;color:#4b5563;font-size:0.875rem;` +
    `line-height:1.4;text-decoration:none}`,
  `.sb-tab:hover{color:#1f2937;background:#f3f4f6}`,
  `.sb-tab:focus-visible{outline:2px solid #1d4ed8;outline-offset:2px}`,
  `.sb-item-active .sb-tab{color:#1d4ed8;background:#eff6ff;` +
    `border-left-color:#1d4ed8;font-weight:600}`,
  /* --- collapsed form: sticky top row, tabs scroll horizontally --- */
  `@media (max-width:736px){` +
    `.sb-nav{display:flex;align-items:center;gap:0.75rem;width:auto;` +
      `max-height:none;overflow-y:visible;z-index:10;` +
      `padding:0.5rem 0.75rem;border-right:none;` +
      `border-bottom:1px solid #e5e7eb}` +
    `.sb-wordmark{flex:0 0 auto;margin:0;padding:0;font-size:0.875rem;` +
      `max-width:7.5rem;overflow:hidden;text-overflow:ellipsis;` +
      `white-space:nowrap}` +
    `.sb-wordmark::after{display:none}` +
    `.sb-tabs{flex:1 1 auto;flex-direction:row;gap:0.25rem;min-width:0;` +
      `overflow-x:auto;-webkit-overflow-scrolling:touch;` +
      `scrollbar-width:thin}` +
    `.sb-tab{border-left:none;white-space:nowrap}` +
    `}`
].join("\n");

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
