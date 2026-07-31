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
 *
 * ── The CSS-only filter mechanism ──────────────────────────────────────
 *
 * The integrator places `renderFilterChips(...)` output immediately before
 * `renderCardsGrid(...)` output, under the SAME parent element. The chip
 * row string deliberately emits the radio inputs as top-level nodes BEFORE
 * the `.cd-filters` label row, so the inputs are document siblings of both
 * `.cd-filters` and the following `.cd-grid` — which is what lets the
 * general-sibling combinator (~) drive everything without JavaScript:
 *
 *   <input id="cd-filter-all" …>  <input id="cd-filter-<type>" …>  (one per type)
 *   <div class="cd-filters">   …one <label class="cd-chip"> per input… </div>
 *   <div class="cd-grid">      …<a class="cd-card cd-type-<type>">…    </div>
 *
 * Exact selectors (all live in `cardsCss` below; <type> ranges over the
 * closed CommitType set, so the rules are static and deterministic):
 *
 *   #cd-filter-<type>:checked~.cd-grid .cd-card:not(.cd-type-<type>){display:none}
 *     → checking a type radio hides every card of any OTHER type.
 *       No rule targets #cd-filter-all, so "All" shows every card.
 *
 *   #cd-filter-<id>:checked~.cd-filters .cd-chip[for="cd-filter-<id>"]{…}
 *     → lights the chip belonging to the checked radio (<id> = "all" or a type).
 *
 *   #cd-filter-<id>:focus-visible~.cd-filters .cd-chip[for="cd-filter-<id>"]{…}
 *     → draws the keyboard focus ring on the chip while its (visually
 *       hidden, still focusable) radio has focus.
 *
 *   .cd-filter-input{position:absolute;…;clip-path:inset(50%)}
 *     → hides the radios visually WITHOUT display:none, so arrow-key
 *       radio-group navigation keeps working for keyboard users.
 */

import { escAttr, escHtml } from "./escape.js";
import type { CardModel } from "./dashboardTypes.js";
import type { CommitType } from "./render.js";

// ---------------------------------------------------------------------------
// Commit-type vocabulary (closed set — safe in ids, class names, selectors)
// ---------------------------------------------------------------------------

/**
 * Reader-facing chip/tag labels. `Record<CommitType, …>` keeps this
 * exhaustive by construction: adding a CommitType without a label is a
 * compile error.
 */
const TYPE_LABELS: Record<CommitType, string> = {
  feature: "Feature",
  fix: "Fix",
  docs: "Docs",
  test: "Test",
  housekeeping: "Housekeeping"
};

/** Every commit type, in stable declaration order (drives static CSS rules). */
const ALL_TYPES = Object.keys(TYPE_LABELS) as readonly CommitType[];

/**
 * One accent per type so a mixed grid can be scanned by colour — but the
 * tag glyphs stay text-first (the word IS the tag; colour never the only
 * carrier). Tints stay in the page's light, low-chroma register; `text` is
 * ≥4.5:1 on its tint.
 */
const TYPE_TINTS: Record<CommitType, { text: string; bg: string; border: string }> = {
  feature: { text: "#1d4ed8", bg: "#eff6ff", border: "#bfdbfe" },
  fix: { text: "#b45309", bg: "#fffbeb", border: "#fde68a" },
  docs: { text: "#6d28d9", bg: "#f5f3ff", border: "#ddd6fe" },
  test: { text: "#047857", bg: "#ecfdf5", border: "#a7f3d0" },
  housekeeping: { text: "#4b5563", bg: "#f3f4f6", border: "#e5e7eb" }
};

/** ◇ provenance mark — same markup as render.ts so the shared `prov` style applies. */
const INFERRED_MARK =
  `<span class="prov" title="AI interpretation: narrated title, not a derived fact">◇</span>`;

const ACTIVE_CHIP = `color:#1d4ed8;border-color:#1d4ed8;background:#eff6ff;font-weight:600`;
const FOCUS_RING = `outline:2px solid #1d4ed8;outline-offset:2px`;

// ---------------------------------------------------------------------------
// CSS (static — rules exist for every CommitType; absent types simply never match)
// ---------------------------------------------------------------------------

/** Chip active/focus styling, mirrored onto the label of the checked/focused radio. */
const chipStateRules = ["all", ...ALL_TYPES]
  .map(
    (id) =>
      `#cd-filter-${id}:checked~.cd-filters .cd-chip[for="cd-filter-${id}"]{${ACTIVE_CHIP}}\n` +
      `#cd-filter-${id}:focus-visible~.cd-filters .cd-chip[for="cd-filter-${id}"]{${FOCUS_RING}}`
  )
  .join("\n");

/** The show/hide core: a checked type radio hides every non-matching card. */
const cardHideRules = ALL_TYPES.map(
  (type) =>
    `#cd-filter-${type}:checked~.cd-grid .cd-card:not(.cd-type-${type}){display:none}`
).join("\n");

/** Per-type tag tints. */
const tagTintRules = ALL_TYPES.map((type) => {
  const tint = TYPE_TINTS[type];
  return `.cd-tag-${type}{color:${tint.text};background:${tint.bg};border-color:${tint.border}}`;
}).join("\n");

/** All cards/chips CSS. Concatenated into the single <style> by the integrator. */
export const cardsCss = `
/* --- home cards + filter chips (cd-) --- */
/* Radios: visually hidden, still focusable (never display:none). */
.cd-filter-input{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%)}
.cd-filters{display:flex;flex-wrap:wrap;gap:0.375rem;margin:0 0 1.25rem}
.cd-chip{cursor:pointer;color:#4b5563;font-size:0.8125rem;line-height:1.5;padding:0.25rem 0.75rem;border:1px solid #e5e7eb;border-radius:999px;background:#ffffff}
.cd-chip:hover{color:#1f2937;border-color:#d1d5db;background:#f9fafb}
${chipStateRules}
${cardHideRules}
/* Cards grid: auto-fill columns; a single column falls out naturally at 320px. */
.cd-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(14rem,1fr));gap:1rem}
.cd-card{display:flex;flex-direction:column;gap:0.375rem;background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;padding:1rem;color:inherit;text-decoration:none;transition:border-color 120ms ease,box-shadow 120ms ease}
.cd-card:hover{border-color:#d1d5db;box-shadow:0 2px 8px rgba(17,24,39,0.08)}
.cd-meta{display:flex;align-items:center;gap:0.5rem;margin:0}
.cd-tag{font-size:0.6875rem;font-weight:600;line-height:1.7;padding:0 0.5rem;border-radius:999px;border:1px solid transparent}
${tagTintRules}
code.cd-sha{background:transparent;border:none;padding:0;color:#9ca3af;font-size:0.75rem}
/* Reset the base h3 (uppercase micro-heading) back to a card headline. */
.cd-title{font-size:0.9375rem;font-weight:600;letter-spacing:0;text-transform:none;color:#1f2937;margin:0}
.cd-summary{font-size:0.8125rem;color:#6b7280;margin:0}
.cd-chapters{display:flex;flex-wrap:wrap;gap:0.25rem;margin:auto 0 0;padding-top:0.375rem}
.cd-chapter{font-size:0.6875rem;line-height:1.7;color:#6b7280;border:1px solid #e5e7eb;border-radius:999px;padding:0 0.5rem}
.cd-arrow{margin-left:auto;color:#9ca3af;transition:transform 120ms ease,color 120ms ease}
.cd-card:hover .cd-arrow{color:#1d4ed8;transform:translateX(2px)}
@media (prefers-reduced-motion:reduce){
.cd-card,.cd-arrow{transition:none}
.cd-card:hover .cd-arrow{transform:none}
}
`;

// ---------------------------------------------------------------------------
// Renderers (pure string builders — no I/O, no Date/random, no <style>)
// ---------------------------------------------------------------------------

/**
 * Render the CSS-only filter chip row: an "All" chip plus one chip per
 * commit type present, in the order given. The radio inputs are emitted
 * BEFORE the `.cd-filters` label row, at the top level of the returned
 * string, so they end up as document siblings of the label row and of the
 * `.cd-grid` that follows — the sibling selectors in `cardsCss` (see the
 * module comment) depend on exactly this shape. Pure; deterministic.
 * `types` is a closed set (CommitType) — values are safe in ids and class
 * names without escaping.
 */
export function renderFilterChips(types: readonly CommitType[]): string {
  const inputs = [
    `<input type="radio" name="cd-filter" id="cd-filter-all" class="cd-filter-input" checked>`,
    ...types.map(
      (type) =>
        `<input type="radio" name="cd-filter" id="cd-filter-${type}" class="cd-filter-input">`
    )
  ].join("");
  const chips = [
    `<label class="cd-chip" for="cd-filter-all">All</label>`,
    ...types.map(
      (type) =>
        `<label class="cd-chip" for="cd-filter-${type}">${escHtml(TYPE_LABELS[type])}</label>`
    )
  ].join("");
  return (
    inputs +
    `<div class="cd-filters" role="group" aria-label="Filter changes by type">` +
    chips +
    `</div>`
  );
}

/** One commit card: an anchor onto the commit's own page (#u{index}). */
function renderCard(card: CardModel): string {
  const mark = card.titleInferred ? ` ${INFERRED_MARK}` : "";
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
    `<p class="cd-meta">` +
    `<span class="cd-tag cd-tag-${card.type}">${escHtml(TYPE_LABELS[card.type])}</span>` +
    sha +
    `<span class="cd-arrow" aria-hidden="true">→</span>` +
    `</p>` +
    `<h3 class="cd-title">${escHtml(card.title)}${mark}</h3>` +
    summary +
    (chips === "" ? "" : `<p class="cd-chapters">${chips}</p>`) +
    `</a>`
  );
}

/**
 * Render the commit cards grid, one anchor-card per model, in the order
 * given (index order = manifest order). Pure; deterministic; every
 * repo-derived string escaped at output.
 */
export function renderCardsGrid(units: readonly CardModel[]): string {
  return `<div class="cd-grid">${units.map(renderCard).join("")}</div>`;
}
