/**
 * Escaping module — the single choke point between repo-controlled strings
 * and HTML/SVG output.
 *
 * The analyzed repository is hostile input: file names, symbols, commit
 * subjects, and narration text may contain markup, attribute breakouts, or
 * `javascript:` URLs. Every repo-controlled string MUST pass through
 * `escHtml`/`escAttr` before landing in markup, and every href through
 * `safeUrl` first (then `escAttr`). No other module may hand-roll escaping.
 */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

/** Escape a string for use as HTML text content (and SVG `<text>`). */
export function escHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] as string);
}

/**
 * Escape a string for use inside a double- or single-quoted HTML attribute.
 * Same character set as `escHtml`; kept as a separate name so call sites
 * document intent and the two can diverge safely later.
 */
export function escAttr(value: string): string {
  return escHtml(value);
}

/**
 * URL allowlist: `https:` always passes; `http:` passes only when the URL's
 * origin is in `allowedOrigins` (configured repo origins, e.g. an internal
 * Git host). Everything else — `javascript:`, `data:`, `file:`, relative or
 * malformed URLs — returns `null`; callers must then render the value as
 * plain (escaped) text, never as a link.
 *
 * The returned value is the WHATWG-normalized href. It is safe as a URL,
 * not as markup: still pass it through `escAttr` when emitting.
 */
export function safeUrl(
  value: string,
  allowedOrigins: readonly string[] = []
): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol === "https:") return url.href;
  // Only ever widen to http: — no allowlist entry can admit another scheme.
  if (url.protocol === "http:" && allowedOrigins.includes(url.origin)) {
    return url.href;
  }
  return null;
}
