/**
 * Build-time Mermaid rendering — REAL mermaid, no browser, no network.
 *
 * The engine (a DOM plus Mermaid itself, with deterministic text-metric
 * stubs) lives in mermaidEngine.ts and is loaded through a dynamic import.
 * That single seam is what lets the shipped plugin CARRY Mermaid: the
 * bundler emits the engine as one self-contained sibling artifact that the
 * plugin scripts load by relative path, so real Mermaid renders on any
 * machine, offline, with no Docker and no downloads.
 *
 * Configuration is locked down: securityLevel "strict", htmlLabels false
 * (labels become plain SVG <text>, never <foreignObject> HTML), theme
 * "base", deterministic ids. The produced SVG is then SANITIZED here —
 * defense in depth, we never trust the library's output:
 *   - script/foreignObject/iframe/image/use/animate elements removed,
 *   - every on* handler attribute stripped,
 *   - href/xlink:href allowed only as #fragment or safeUrl-validated,
 *   - style attributes and the scoped <style> block lose any url() that
 *     is not a #fragment reference,
 *   - role normalized to img (accessible image, not a widget tree).
 *
 * Every entry point still fails SOFT — `{ ok: false, reason }` — if the
 * engine cannot be loaded at all, so the caller can fall back down the
 * render chain (docs/decisions/0002-mermaid-render-chain.md).
 */

import type { BookManifest, ChangeManifest } from "@gitiviz/schema";
import { safeUrl } from "./escape.js";
import type { DomApi, DomElement, MermaidRenderer } from "./mermaidEngine.js";
import {
  collectMermaidSources,
  renderChangeBook,
  type PrerenderedDiagram,
  type RenderOptions
} from "./render.js";

/**
 * The engine module, loaded lazily by specifier so the bundler can swap in
 * the committed sibling artifact (`./mermaid-engine.mjs`). Never import it
 * statically — the whole point is that the heavy engine loads on demand.
 */
async function engineModule(): Promise<typeof import("./mermaidEngine.js")> {
  return import("./mermaidEngine.js");
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type MermaidRenderResult =
  | { ok: true; svg: string }
  | { ok: false; reason: string };

export interface MermaidSvgOptions {
  /** Origins allowed for http: hrefs inside the SVG (https: always passes). */
  allowedOrigins?: readonly string[];
}

/**
 * The one Mermaid configuration for every render engine gitiviz uses —
 * the in-process bundled engine AND the mermaid-cli Docker fallback the
 * CLI writes this object out for (as mermaid-config.json). Locked down:
 * securityLevel "strict", htmlLabels false (labels are plain SVG <text>,
 * never <foreignObject> HTML), deterministic ids, light "base" theme
 * matching the book shell. All values are constants — nothing here is
 * repo-controlled.
 */
export const MERMAID_RENDER_CONFIG = {
  startOnLoad: false,
  securityLevel: "strict",
  theme: "base",
  htmlLabels: false,
  deterministicIds: true,
  deterministicIDSeed: "gitiviz",
  themeVariables: {
    fontFamily:
      '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
    fontSize: "14px",
    lineColor: "#6b7280",
    primaryTextColor: "#1f2937",
    edgeLabelBackground: "#ffffff",
    clusterBkg: "#f8fafc",
    clusterBorder: "#cbd5e1"
  },
  flowchart: {
    htmlLabels: false,
    nodeSpacing: 55,
    rankSpacing: 65,
    padding: 12,
    // Labels are three short lines by construction; mid-line wrapping
    // under jsdom measures inconsistently between layout and draw, so
    // give lines room to stay whole.
    wrappingWidth: 480
  }
} as const;

/** The DOM used by the sanitizer; loaded on first use, then cached. */
async function loadDomApi(): Promise<DomApi> {
  return (await engineModule()).loadDom();
}

/** The Mermaid instance; loaded on first use, then cached by the engine. */
async function loadRenderer(): Promise<MermaidRenderer> {
  return (await engineModule()).loadMermaidRenderer({ ...MERMAID_RENDER_CONFIG });
}

// ---------------------------------------------------------------------------
// SVG sanitizer (defense in depth over mermaid's own strict mode)
// ---------------------------------------------------------------------------

/**
 * Elements never allowed in a rendered diagram. Shared with the
 * dependency-free text sanitizer (svgSanitizeLite.ts) so both enforce the
 * same policy.
 */
export const FORBIDDEN_SVG_TAGS: ReadonlySet<string> = new Set([
  "script",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "image",
  "img",
  "use",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
  "link",
  "meta",
  "audio",
  "video"
]);

/** Strip url(...) values unless they reference a local #fragment. */
export function scrubCssUrls(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, "")
    .replace(/url\(\s*(['"]?)(?!#)[^)]*\1\s*\)/gi, "none");
}

function hrefAllowed(value: string, allowedOrigins: readonly string[]): boolean {
  if (value.startsWith("#")) return true;
  return safeUrl(value, allowedOrigins) !== null;
}

/**
 * Sanitize a (mermaid-produced or hostile) SVG string. Returns the cleaned
 * `<svg>` element markup, or null when the input has no svg root. Pure with
 * respect to its input; async only because the DOM loads lazily.
 */
export async function sanitizeMermaidSvg(
  svg: string,
  options: MermaidSvgOptions = {}
): Promise<string | null> {
  const allowedOrigins = options.allowedOrigins ?? [];
  const dom = await loadDomApi();
  const document = dom.parseDocument(`<!DOCTYPE html><body>${svg}</body>`);
  const root = document.body.querySelector("svg");
  if (root === null) return null;

  // Element pass (snapshot first — we mutate as we go).
  for (const el of Array.from(root.querySelectorAll("*")) as DomElement[]) {
    if (FORBIDDEN_SVG_TAGS.has(el.tagName.toLowerCase())) {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes) as DomElement[]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
      } else if (name === "href" || name === "xlink:href") {
        if (!hrefAllowed(attr.value, allowedOrigins)) el.removeAttribute(attr.name);
      } else if (name === "style") {
        const scrubbed = scrubCssUrls(attr.value);
        if (scrubbed !== attr.value) el.setAttribute(attr.name, scrubbed);
      }
    }
    if (el.tagName.toLowerCase() === "style") {
      const scrubbed = scrubCssUrls(el.textContent ?? "");
      if (scrubbed !== el.textContent) el.textContent = scrubbed;
    }
  }
  // Root attribute pass.
  for (const attr of Array.from(root.attributes) as DomElement[]) {
    const name = attr.name.toLowerCase();
    if (name.startsWith("on")) root.removeAttribute(attr.name);
  }

  // Present as an accessible image, not an interactive document tree.
  root.setAttribute("role", "img");
  root.removeAttribute("aria-roledescription");

  return root.outerHTML;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** DOM ids are generated locally; refuse anything that could break markup. */
const SAFE_DOM_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Render one compiled Mermaid text to sanitized standalone SVG markup.
 * `domId` becomes the SVG element id (and its scoped-style prefix), so it
 * must be unique per page slot and match /^[A-Za-z][A-Za-z0-9_-]*$/.
 * Fails soft with a reason instead of throwing.
 */
export async function renderMermaidDiagram(
  domId: string,
  text: string,
  options: MermaidSvgOptions = {}
): Promise<MermaidRenderResult> {
  if (!SAFE_DOM_ID.test(domId)) {
    return { ok: false, reason: `unsafe diagram dom id: ${JSON.stringify(domId)}` };
  }
  let renderer: MermaidRenderer;
  try {
    renderer = await loadRenderer();
  } catch (error) {
    return {
      ok: false,
      reason: `mermaid environment unavailable: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  try {
    const svg = await renderer.render(domId, text);
    const clean = await sanitizeMermaidSvg(svg, options);
    if (clean === null) {
      return { ok: false, reason: "mermaid produced no svg root" };
    }
    return { ok: true, svg: clean };
  } catch (error) {
    return {
      ok: false,
      reason: `mermaid render failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

// ---------------------------------------------------------------------------
// End-to-end convenience: prerender every diagram slot, then render the book
// ---------------------------------------------------------------------------

/**
 * Render the change book with real Mermaid diagrams: collects the page's
 * diagram sources, prerenders each inside this process, and hands the
 * sanitized SVGs to `renderChangeBook`. Slots whose render fails keep the
 * honest built-in fallback. Deterministic end to end.
 */
export async function renderChangeBookWithMermaid(
  book: BookManifest,
  change: ChangeManifest,
  options: RenderOptions = {}
): Promise<string> {
  const sources = collectMermaidSources(book, change, options.mermaid);
  const svgs = new Map<string, PrerenderedDiagram>(options.mermaid?.svgs ?? []);
  for (const { id, text } of sources) {
    if (svgs.has(id)) continue;
    const result = await renderMermaidDiagram(`gitiviz-${id}`, text, {
      ...(options.mermaid?.allowedOrigins !== undefined
        ? { allowedOrigins: options.mermaid.allowedOrigins }
        : {})
    });
    if (result.ok) svgs.set(id, { text, svg: result.svg });
  }
  return renderChangeBook(book, change, {
    ...options,
    mermaid: { ...options.mermaid, svgs }
  });
}
