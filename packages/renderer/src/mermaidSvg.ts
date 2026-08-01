/**
 * Build-time Mermaid rendering — REAL mermaid, no browser, no network.
 *
 * Mermaid v11 runs server-side under jsdom inside the Docker container:
 * jsdom has no layout engine, so deterministic text-metric stubs
 * (character-width estimates) stand in for getBBox/getComputedTextLength.
 * The same input therefore always yields byte-identical SVG.
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
 * jsdom and mermaid are devDependencies loaded via dynamic import: when
 * either is unavailable (e.g. in the bundled plugin runtime) every entry
 * point fails SOFT — `{ ok: false, reason }` — and the caller falls back
 * to the built-in SVG engine with an honest note.
 */

import type { BookManifest, ChangeManifest } from "@gitiviz/schema";
import { safeUrl } from "./escape.js";
import {
  collectMermaidSources,
  renderChangeBook,
  type PrerenderedDiagram,
  type RenderOptions
} from "./render.js";

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

// ---------------------------------------------------------------------------
// jsdom environment (singleton — mermaid caches DOM globals at import time)
// ---------------------------------------------------------------------------

/**
 * Deterministic text metrics: generous character estimates (no randomness).
 * Slight over-estimation is intentional — dagre then reserves breathing
 * room, so real glyphs never overlap node borders or cluster titles.
 */
const CHAR_WIDTH = 8;
const LINE_HEIGHT = 24;
const GEO_SKIP_TAGS = new Set(["style", "defs", "marker", "title", "desc"]);

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type DomElement = any;

function textEstimate(el: DomElement): { width: number; height: number } {
  const rows: DomElement[] = Array.from(
    el.querySelectorAll?.(".text-outer-tspan") ?? []
  );
  if (rows.length > 0) {
    let width = 0;
    for (const row of rows) {
      width = Math.max(width, String(row.textContent ?? "").length * CHAR_WIDTH);
    }
    return { width, height: rows.length * LINE_HEIGHT };
  }
  const lines = String(el.textContent ?? "").split("\n");
  const width = Math.max(...lines.map((l) => l.length), 1) * CHAR_WIDTH;
  return { width, height: lines.length * LINE_HEIGHT };
}

function parseTranslate(el: DomElement): { dx: number; dy: number } {
  const transform = el.getAttribute?.("transform") ?? "";
  const match = /translate\(\s*(-?[\d.]+)[ ,]\s*(-?[\d.]+)\s*\)/.exec(transform);
  return match
    ? { dx: Number(match[1]), dy: Number(match[2]) }
    : { dx: 0, dy: 0 };
}

/** Recursive geometry union over rects, paths, and texts with translates. */
function geometryBox(el: DomElement): Box | null {
  const tag = String(el.tagName ?? "").toLowerCase();
  if (GEO_SKIP_TAGS.has(tag)) return null;
  if (tag === "rect") {
    const x = Number(el.getAttribute("x") ?? 0);
    const y = Number(el.getAttribute("y") ?? 0);
    const w = Number(el.getAttribute("width") ?? 0);
    const h = Number(el.getAttribute("height") ?? 0);
    if (!Number.isFinite(x + y + w + h) || (w === 0 && h === 0)) return null;
    return { minX: x, minY: y, maxX: x + w, maxY: y + h };
  }
  if (tag === "path") {
    const d = el.getAttribute("d") ?? "";
    let box: Box | null = null;
    for (const [, xs, ys] of d.matchAll(/(-?\d+(?:\.\d+)?)[ ,](-?\d+(?:\.\d+)?)/g)) {
      const x = Number(xs);
      const y = Number(ys);
      box = box === null
        ? { minX: x, minY: y, maxX: x, maxY: y }
        : {
            minX: Math.min(box.minX, x),
            minY: Math.min(box.minY, y),
            maxX: Math.max(box.maxX, x),
            maxY: Math.max(box.maxY, y)
          };
    }
    return box;
  }
  if (tag === "text") {
    const est = textEstimate(el);
    return { minX: -est.width / 2, minY: 0, maxX: est.width / 2, maxY: est.height };
  }
  let union: Box | null = null;
  for (const child of Array.from(el.children ?? []) as DomElement[]) {
    const box = geometryBox(child);
    if (box === null) continue;
    const { dx, dy } = parseTranslate(child);
    const shifted: Box = {
      minX: box.minX + dx,
      minY: box.minY + dy,
      maxX: box.maxX + dx,
      maxY: box.maxY + dy
    };
    union = union === null
      ? shifted
      : {
          minX: Math.min(union.minX, shifted.minX),
          minY: Math.min(union.minY, shifted.minY),
          maxX: Math.max(union.maxX, shifted.maxX),
          maxY: Math.max(union.maxY, shifted.maxY)
        };
  }
  return union;
}

function estimateBBox(el: DomElement): { x: number; y: number; width: number; height: number } {
  const tag = String(el.tagName ?? "").toLowerCase();
  // Text measures by its rows; everything else geometry-first (rects must
  // report their real width/height — mermaid reads node bounds off them).
  if (tag !== "text" && tag !== "tspan") {
    const box = geometryBox(el);
    if (box !== null) {
      return {
        x: box.minX,
        y: box.minY,
        width: box.maxX - box.minX,
        height: box.maxY - box.minY
      };
    }
  }
  const est = textEstimate(el);
  return { x: 0, y: 0, width: est.width, height: est.height };
}

/**
 * The one Mermaid configuration for every render engine gitiviz uses —
 * the in-process jsdom path below AND the mermaid-cli Docker fallback the
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

interface MermaidEnv {
  window: DomElement;
  mermaid: DomElement;
}

let envPromise: Promise<MermaidEnv> | null = null;

async function loadEnv(): Promise<MermaidEnv> {
  if (envPromise === null) {
    envPromise = (async () => {
      const { JSDOM } = await import("jsdom");
      const dom = new JSDOM(`<!DOCTYPE html><body></body>`, {
        url: "https://localhost/"
      });
      const { window } = dom as DomElement;

      const g = globalThis as DomElement;
      if (g.window === undefined) g.window = window;
      if (g.document === undefined) g.document = window.document;
      for (const key of [
        "SVGElement",
        "Element",
        "Node",
        "HTMLElement",
        "DocumentFragment",
        "MutationObserver",
        "XMLSerializer",
        "DOMParser",
        "CSSStyleSheet"
      ]) {
        if (g[key] === undefined) g[key] = window[key];
      }

      for (const cls of [
        window.SVGElement,
        window.SVGGraphicsElement,
        window.SVGTextContentElement,
        window.SVGSVGElement
      ]) {
        if (cls === undefined) continue;
        cls.prototype.getBBox = function (this: DomElement) {
          return estimateBBox(this);
        };
        cls.prototype.getComputedTextLength = function (this: DomElement) {
          return String(this.textContent ?? "").length * CHAR_WIDTH;
        };
      }
      window.Element.prototype.getBoundingClientRect = function (this: DomElement) {
        const est = estimateBBox(this);
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          width: est.width,
          height: est.height,
          right: est.width,
          bottom: est.height,
          toJSON: () => ({})
        };
      };

      const mermaid = (await import("mermaid")).default as DomElement;
      mermaid.initialize({ ...MERMAID_RENDER_CONFIG });
      return { window, mermaid };
    })();
  }
  return envPromise;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

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
 * respect to its input; async only because jsdom loads lazily.
 */
export async function sanitizeMermaidSvg(
  svg: string,
  options: MermaidSvgOptions = {}
): Promise<string | null> {
  const allowedOrigins = options.allowedOrigins ?? [];
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(`<!DOCTYPE html><body>${svg}</body>`, {
    url: "https://localhost/"
  });
  const root = dom.window.document.body.querySelector("svg");
  if (root === null) return null;

  // Element pass (snapshot first — we mutate as we go).
  for (const el of Array.from(root.querySelectorAll("*"))) {
    if (FORBIDDEN_SVG_TAGS.has(el.tagName.toLowerCase())) {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
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
  for (const attr of Array.from(root.attributes)) {
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
  let env: MermaidEnv;
  try {
    env = await loadEnv();
  } catch (error) {
    return {
      ok: false,
      reason: `mermaid environment unavailable: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  try {
    const { svg } = await env.mermaid.render(domId, text);
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
