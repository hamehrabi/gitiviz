/**
 * Issues view: the GitHub tickets raised from this book, as cards.
 *
 * Module pattern like cards.ts (see dashboard-contract.md). Class prefix:
 * `iv-`. All CSS for this module lives in `issuesCss`; the integrator
 * concatenates it into the single <style> and wraps the list in
 * `<section id="issues">`.
 *
 * Trust model: the issue list reaches the renderer through
 * `RenderOptions.issues` — the CLI's defensive reader has already
 * shape-validated it, but every STRING in it is still hostile (a hostile
 * repo can commit its own issues.json). Titles, states, and dates escape
 * on output; the state's class name comes from a closed set, never from
 * the string itself. A card becomes a link ONLY when its url passes
 * safeUrl AND its origin equals the configured repository origin exactly
 * — otherwise the card is a linkless <div>. Dates render as the first 10
 * characters of the ISO string (yyyy-mm-dd) — a string slice, no Date
 * object, so rendering stays pure and byte-deterministic.
 */

import { escAttr, escHtml, safeUrl } from "./escape.js";
import type { RenderLinkOptions } from "./links.js";

/**
 * One fetched GitHub issue (interface contract with the CLI — see
 * RenderOptions.issues). All strings are hostile input.
 */
export interface IssueModel {
  number: number;
  title: string;
  state: string;
  url: string;
  createdAt: string;
}

/** Exact empty-state copy (plan-mandated). */
const EMPTY_STATE = "No tickets yet — create one from any commit page.";

/** The honest line about where tickets come from. */
const EMPTY_MECHANISM =
  "Tickets are GitHub issues labeled gitiviz, fetched with your local gh CLI " +
  "each time the book is rebuilt.";

const MONO = `ui-monospace,SFMono-Regular,Menlo,Consolas,monospace`;

// ---------------------------------------------------------------------------
// CSS (concatenated into the single <style> by the integrator — never emit
// a <style> tag here). Only `.iv-*` selectors; light theme only.
// ---------------------------------------------------------------------------

/** All issues-view CSS. Concatenated into the single <style> by the integrator. */
export const issuesCss = `
/* --- issues view (iv-) --- */
.iv-card{display:flex;flex-direction:column;gap:0.375rem;background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;padding:1rem;margin:0 0 1rem;color:inherit;text-decoration:none}
.iv-card-link:hover{border-color:#d1d5db;box-shadow:0 2px 8px rgba(17,24,39,0.08)}
.iv-card-link:focus-visible{outline:2px solid #1d4ed8;outline-offset:2px}
.iv-meta{display:flex;flex-wrap:wrap;align-items:center;gap:0.5rem;margin:0}
.iv-number{font-family:${MONO};font-size:0.75rem;color:#9ca3af}
.iv-state{font-size:0.6875rem;font-weight:600;line-height:1.7;padding:0 0.5rem;border-radius:999px;color:#4b5563;background:#f3f4f6;border:1px solid #e5e7eb;overflow-wrap:anywhere}
.iv-state-open{color:#047857;background:#ecfdf5;border-color:#a7f3d0}
.iv-state-closed{color:#6d28d9;background:#f5f3ff;border-color:#ddd6fe}
.iv-date{font-size:0.75rem;color:#9ca3af}
.iv-title{font-size:0.9375rem;font-weight:600;color:#1f2937;margin:0}
.iv-empty{margin:0.75rem 0 0.25rem}
.iv-empty-note{margin:0.25rem 0;font-size:0.875rem;color:#6b7280}
`;

// ---------------------------------------------------------------------------
// Link policy (mirrors links.ts in spirit; issues carry ABSOLUTE urls, so
// the check is: allowlisted scheme + exact repo-origin match)
// ---------------------------------------------------------------------------

/**
 * Validate one issue url into a linkable href, or null. `links.origin` is
 * the repository's web URL (interface contract); the issue url must pass
 * the safeUrl allowlist AND share its origin exactly. The result is safe
 * as a URL, not as markup — it still passes escAttr at output.
 */
function issueUrl(
  url: string,
  links: RenderLinkOptions | undefined
): string | null {
  if (links?.origin === undefined) return null;
  const safe = safeUrl(url, links.allowedOrigins ?? []);
  if (safe === null) return null;
  let repoOrigin: string;
  try {
    repoOrigin = new URL(links.origin).origin;
  } catch {
    return null;
  }
  if (new URL(safe).origin !== repoOrigin) return null;
  // Belt and braces: nothing that could escape a quoted context.
  if (/["\s<>\\]/.test(safe)) return null;
  return safe;
}

// ---------------------------------------------------------------------------
// Renderers (pure string builders — no I/O, no Date/random, no <style>)
// ---------------------------------------------------------------------------

/** Closed set for pill class names — never derived from the hostile string. */
function stateKind(state: string): "open" | "closed" | "other" {
  const normalized = state.toLowerCase();
  if (normalized === "open") return "open";
  if (normalized === "closed") return "closed";
  return "other";
}

/**
 * One issue card: #number, state pill, yyyy-mm-dd date, title. An anchor
 * only when the url survives `issueUrl`; a plain div otherwise.
 */
function renderIssueCard(
  issue: IssueModel,
  links: RenderLinkOptions | undefined
): string {
  const kind = stateKind(issue.state);
  // Recognized states display normalized (gh reports OPEN/CLOSED); anything
  // else shows the escaped raw text — honest, never markup.
  const stateLabel = kind === "other" ? escHtml(issue.state) : kind;
  const date = issue.createdAt.slice(0, 10);
  const dateHtml =
    date === "" ? "" : `<span class="iv-date">${escHtml(date)}</span>`;
  const body =
    `<p class="iv-meta">` +
    `<span class="iv-number">#${issue.number}</span>` +
    `<span class="iv-state iv-state-${kind}">${stateLabel}</span>` +
    dateHtml +
    `</p>` +
    `<p class="iv-title">${escHtml(issue.title)}</p>`;
  const url = issueUrl(issue.url, links);
  if (url === null) return `<div class="iv-card">${body}</div>`;
  return (
    `<a class="iv-card iv-card-link" href="${escAttr(url)}" ` +
    `target="_blank" rel="noopener">${body}</a>`
  );
}

/**
 * Render the issue list (manifest order — the fetcher already sorts by
 * creation, newest first) or the honest empty state. Pure; deterministic;
 * every repo-controlled string escaped at output.
 */
export function renderIssuesList(
  issues: readonly IssueModel[],
  links?: RenderLinkOptions
): string {
  if (issues.length === 0) {
    return (
      `<p class="iv-empty">${escHtml(EMPTY_STATE)}</p>` +
      `<p class="iv-empty-note">${escHtml(EMPTY_MECHANISM)}</p>`
    );
  }
  return issues.map((issue) => renderIssueCard(issue, links)).join("");
}
