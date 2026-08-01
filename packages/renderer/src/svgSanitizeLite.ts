/**
 * Dependency-free SVG sanitizer — the SAME policy as `sanitizeMermaidSvg`
 * (mermaidSvg.ts) implemented with string operations only, for runtimes
 * where jsdom is not installed: the committed dependency-free plugin bundle
 * picking up SVGs produced by the mermaid-cli Docker image.
 *
 *   - script/foreignObject/iframe/image/use/animate elements removed,
 *   - every on* handler attribute stripped,
 *   - href/xlink:href allowed only as #fragment or safeUrl-validated,
 *   - style attributes and <style> blocks lose any url() that is not a
 *     #fragment reference,
 *   - role normalized to img, aria-roledescription removed.
 *
 * The inputs here are machine-generated Mermaid SVGs (labels already
 * entity-escaped by the compiler), so text content never contains a raw
 * "<" and a tag-by-tag regex pass is sound. Policy parity with the jsdom
 * sanitizer is enforced by tests that run both over the same inputs.
 */

import { safeUrl } from "./escape.js";
import type { MermaidSvgOptions } from "./mermaidSvg.js";
import { FORBIDDEN_SVG_TAGS, scrubCssUrls } from "./mermaidSvg.js";

/** Attribute run of a tag: unquoted chars or complete quoted strings. */
const TAG_RE = /<([A-Za-z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

function sanitizeAttrs(attrs: string, allowedOrigins: readonly string[]): string {
  return attrs
    // Event handlers, quoted or bare.
    .replace(/\son[A-Za-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/g, "")
    // Quoted hrefs: keep #fragments and allowlisted URLs, drop the rest.
    .replace(
      /\s(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
      (match, dq: string | undefined, sq: string | undefined) => {
        const value = dq ?? sq ?? "";
        if (value.startsWith("#")) return match;
        return safeUrl(value, allowedOrigins) !== null ? match : "";
      }
    )
    // Unquoted hrefs: always drop (the DOM sanitizer never sees these).
    .replace(/\s(?:xlink:)?href\s*=\s*(?!["'])[^\s>]+/gi, "")
    // style attributes: scrub external url() references.
    .replace(/\sstyle\s*=\s*"([^"]*)"/gi, (_m, css: string) => ` style="${scrubCssUrls(css)}"`)
    .replace(/\sstyle\s*=\s*'([^']*)'/gi, (_m, css: string) => ` style='${scrubCssUrls(css)}'`);
}

/**
 * Sanitize an SVG string without a DOM. Returns the cleaned `<svg>` element
 * markup, or null when the input has no svg root. Pure and synchronous.
 */
export function sanitizeMermaidSvgText(
  svg: string,
  options: MermaidSvgOptions = {}
): string | null {
  const allowedOrigins = options.allowedOrigins ?? [];

  // 1. Extract the svg root element.
  const start = svg.search(/<svg[\s>]/i);
  const end = svg.toLowerCase().lastIndexOf("</svg>");
  if (start < 0 || end < start) return null;
  let out = svg.slice(start, end + "</svg>".length);

  // 2. Remove forbidden elements: paired blocks (repeat for nesting), then
  //    any self-closing or stray open/close tags left over.
  for (const tag of FORBIDDEN_SVG_TAGS) {
    const paired = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, "gi");
    let previous: string;
    do {
      previous = out;
      out = out.replace(paired, "");
    } while (out !== previous);
    out = out.replace(new RegExp(`<${tag}\\b[^>]*/?>|</${tag}\\s*>`, "gi"), "");
  }

  // 3. Attribute pass over every remaining tag.
  out = out.replace(TAG_RE, (_match, name: string, attrs: string) => {
    return `<${name}${sanitizeAttrs(attrs, allowedOrigins)}>`;
  });

  // 4. <style> block contents: strip external url() references.
  out = out.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_m, open: string, css: string, close: string) => `${open}${scrubCssUrls(css)}${close}`
  );

  // 5. Root element: accessible image, not an interactive document tree.
  out = out.replace(/^<svg\b((?:[^>"']|"[^"]*"|'[^']*')*)>/i, (_m, attrs: string) => {
    const cleaned = attrs
      .replace(/\saria-roledescription\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, "")
      .replace(/\srole\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, "");
    return `<svg${cleaned} role="img">`;
  });

  return out;
}
