/**
 * The Mermaid engine itself: a real DOM (jsdom) plus real Mermaid, wired
 * together with deterministic text metrics.
 *
 * This module is deliberately the ONLY place that touches `jsdom` and
 * `mermaid`. Everything else in the renderer talks to it through the two
 * loader functions below, which means the whole engine can be bundled into
 * a single self-contained artifact and loaded by relative path — that is
 * how the shipped plugin carries Mermaid with it and renders real Mermaid
 * diagrams on any machine, offline, with no Docker and no downloads (see
 * build/bundle.mjs and docs/decisions/0002-mermaid-render-chain.md).
 *
 * jsdom has no layout engine, so `getBBox` / `getComputedTextLength` /
 * `getBoundingClientRect` are stubbed with character-width estimates. They
 * are pure functions of the markup — no randomness, no timing — so the same
 * diagram source always lays out identically and the emitted SVG is
 * byte-identical run to run.
 *
 * Both loaders fail SOFT by throwing a plain Error; callers turn that into
 * `{ ok: false, reason }` and fall back down the render chain.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Untyped DOM values: jsdom's surface is far wider than what we touch. */
export type DomElement = any;

// ---------------------------------------------------------------------------
// Deterministic text metrics (no layout engine exists under jsdom)
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

function estimateBBox(el: DomElement): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
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

// ---------------------------------------------------------------------------
// DOM loader
// ---------------------------------------------------------------------------

/** The slice of a DOM implementation the renderer needs. */
export interface DomApi {
  /** Parse an HTML fragment; returns its `document`. */
  parseDocument(html: string): DomElement;
}

let domPromise: Promise<{ api: DomApi; JSDOM: DomElement }> | null = null;

async function loadJsdom(): Promise<{ api: DomApi; JSDOM: DomElement }> {
  if (domPromise === null) {
    domPromise = (async () => {
      const { JSDOM } = await import("jsdom");
      const api: DomApi = {
        parseDocument(html: string): DomElement {
          return new JSDOM(html, { url: "https://localhost/" }).window.document;
        }
      };
      return { api, JSDOM };
    })();
  }
  return domPromise;
}

/**
 * The DOM used to parse and sanitize SVG markup. Throws when no DOM is
 * available so the caller can fall back to the dependency-free text
 * sanitizer.
 */
export async function loadDom(): Promise<DomApi> {
  return (await loadJsdom()).api;
}

// ---------------------------------------------------------------------------
// Mermaid loader
// ---------------------------------------------------------------------------

/** A ready-to-use Mermaid instance bound to a live DOM. */
export interface MermaidRenderer {
  /** Render diagram text to RAW (unsanitized) SVG markup. */
  render(domId: string, text: string): Promise<string>;
}

let mermaidPromise: Promise<MermaidRenderer> | null = null;

/**
 * Boot a DOM, install the deterministic metric stubs, then load Mermaid on
 * top of it. Mermaid (and DOMPurify inside it) capture DOM globals at
 * import time, so the globals MUST be installed before the import — hence
 * the dynamic import ordering below, which the bundler preserves.
 *
 * `config` is the shared MERMAID_RENDER_CONFIG; it is applied on the first
 * call and the instance is then cached for the process.
 */
export async function loadMermaidRenderer(
  config: Record<string, unknown>
): Promise<MermaidRenderer> {
  if (mermaidPromise === null) {
    mermaidPromise = (async () => {
      const { JSDOM } = await loadJsdom();
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
      mermaid.initialize({ ...config });
      return {
        async render(domId: string, text: string): Promise<string> {
          const { svg } = await mermaid.render(domId, text);
          return svg as string;
        }
      };
    })();
  }
  return mermaidPromise;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
