/**
 * Responsiveness + accessibility hardening of the rendered dashboard.
 *
 * What this file pins down (from the plan + design doc):
 *   - Every interactive control is a native element (anchor/radio/label/
 *     summary) — no click-handler divs, no tabindex hacks, no ARIA widgets.
 *   - Document structure: `lang`, landmarks (header/nav/main), skip link.
 *   - Small screens: long repo-controlled tokens wrap (`overflow-wrap`) so
 *     320px produces no horizontal scroll, and the sidebar collapses to a
 *     horizontally scrollable tab row under 736px. Layout is asserted at the
 *     CSS-rule level (happy-dom does no real layout; visual check is manual).
 */

import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import type { BookManifest, ChangeManifest } from "@gitiviz/schema";
import { CHAPTER_IDS } from "@gitiviz/schema";
import { compileDiagram } from "./diagram.js";
import { renderChangeBook } from "./render.js";

// ---------------------------------------------------------------------------
// Fixtures (small; long-token variant for wrapping checks)
// ---------------------------------------------------------------------------

const LONG_TOKEN = "AbsurdlyLongUnbrokenIdentifier".repeat(20);

function change(overrides: Partial<ChangeManifest> = {}): ChangeManifest {
  return {
    specVersion: "0.1.0",
    repository: { name: "demo-app" },
    baseRevision: "a".repeat(40),
    headRevision: "b".repeat(40),
    entities: [
      {
        id: "ent-a",
        kind: "route",
        humanLabel: "Create order endpoint",
        technicalLabel: "POST /orders",
        baseState: "unchanged",
        headState: "added",
        provenance: "derived",
        evidence: [{ path: "src/routes/orders.ts" }]
      },
      {
        id: "ent-b",
        kind: "module",
        humanLabel: "Order service",
        baseState: "unchanged",
        headState: "changed",
        provenance: "derived",
        evidence: [{ path: "src/services/orderService.ts" }]
      }
    ],
    relationships: [
      {
        id: "rel-1",
        from: "ent-a",
        to: "ent-b",
        verb: "creates order via",
        baseState: "unchanged",
        headState: "added",
        provenance: "derived"
      }
    ],
    changeUnits: [
      {
        id: "unit-1",
        technicalTitle: "feat: add guest checkout route",
        summary: "Adds a POST /orders route.",
        commits: ["c".repeat(40)],
        entities: ["ent-a", "ent-b"],
        relationships: ["rel-1"],
        provenance: "derived"
      }
    ],
    analysisLimitations: [],
    ...overrides
  };
}

function book(c: ChangeManifest): BookManifest {
  return {
    specVersion: "0.1.0",
    repository: { name: c.repository.name },
    chapters: CHAPTER_IDS.map((id) => ({
      id,
      title: `Title for ${id}`,
      status:
        id === "purpose" || id === "systems" || id === "history"
          ? "generated"
          : "not-written"
    }))
  };
}

function render(c: ChangeManifest = change()): string {
  return renderChangeBook(book(c), c, { renderDiagram: compileDiagram });
}

function parse(html: string) {
  const window = new Window();
  const parser = new window.DOMParser();
  return parser.parseFromString(html, "text/html");
}

function css(html: string): string {
  return parse(html).querySelector("style")!.textContent;
}

/** Selectors of every CSS rule whose declarations contain `decl`. */
function selectorsWith(stylesheet: string, decl: string): string[] {
  const out: string[] = [];
  for (const match of stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[2]!.includes(decl)) out.push(match[1]!.trim());
  }
  return out;
}

// ---------------------------------------------------------------------------
// Native controls only
// ---------------------------------------------------------------------------

describe("native interactive controls", () => {
  it("uses only native interactive elements — no tabindex, no ARIA widget roles", () => {
    const doc = parse(render());
    for (const el of Array.from(doc.querySelectorAll("*"))) {
      expect(el.hasAttribute("tabindex")).toBe(false);
      const role = el.getAttribute("role");
      if (role !== null) {
        // The only role in the document is the diagram image role on <svg>.
        expect(role).toBe("img");
        expect(el.tagName.toLowerCase()).toBe("svg");
      }
    }
    // Nothing dressed up as a button/link via div or span.
    expect(doc.querySelectorAll("div[role],span[role]").length).toBe(0);
    expect(doc.querySelectorAll("button").length).toBe(0);
  });

  it("tab navigation is plain anchors with non-empty names and real targets", () => {
    const doc = parse(render());
    const tabs = Array.from(doc.querySelectorAll("nav.tabs a"));
    expect(tabs.length).toBe(5);
    for (const tab of tabs) {
      expect(tab.textContent.trim().length).toBeGreaterThan(0);
      const href = tab.getAttribute("href")!;
      expect(href.startsWith("#")).toBe(true);
      expect(doc.getElementById(href.slice(1))).not.toBeNull();
    }
  });

  it("labels every filter radio (accessible name comes from the chip)", () => {
    const doc = parse(render());
    const radios = Array.from(
      doc.querySelectorAll('input[type="radio"][name="filter"]')
    );
    expect(radios.length).toBeGreaterThan(0);
    for (const radio of radios) {
      const id = radio.getAttribute("id")!;
      const labels = doc.querySelectorAll(`label[for="${id}"]`);
      expect(labels.length).toBe(1);
      expect(labels[0]!.textContent.trim().length).toBeGreaterThan(0);
    }
  });

  it("hides the filter radios accessibly — clipped, never display:none", () => {
    const style = css(render());
    const rules = selectorsWith(style, "clip-path:inset(50%)");
    expect(rules).toContain('input[name="filter"]');
    for (const selector of selectorsWith(style, "display:none")) {
      expect(selector).not.toContain("input");
    }
    for (const selector of selectorsWith(style, "visibility:hidden")) {
      expect(selector).not.toContain("input");
    }
  });

  it("collapses housekeeping commits behind a native details/summary disclosure", () => {
    const doc = parse(render(change({
      changeUnits: [
        ...change().changeUnits,
        {
          id: "unit-fixup",
          technicalTitle: "fixup! tidy",
          grouped: true,
          groupedReason: "fixup commit",
          commits: ["e".repeat(40)],
          provenance: "derived"
        }
      ]
    })));
    const housekeeping = doc.querySelector("details.housekeeping");
    expect(housekeeping).not.toBeNull();
    expect(housekeeping!.querySelector("summary")).not.toBeNull();
    expect(housekeeping!.hasAttribute("open")).toBe(false);
  });

  it("gives anchors a visible focus indicator and each filter radio one on its chip", () => {
    const style = css(render());
    expect(style).toMatch(/a:focus-visible\{outline:/);
    const doc = parse(render());
    for (const radio of Array.from(
      doc.querySelectorAll('input[type="radio"][name="filter"]')
    )) {
      const id = radio.getAttribute("id")!;
      expect(style).toContain(
        `#${id}:focus-visible~.filters label[for="${id}"]{outline:`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Document structure: lang, landmarks, skip link
// ---------------------------------------------------------------------------

describe("landmarks and skip link", () => {
  it("declares the document language", () => {
    const doc = parse(render());
    expect(doc.documentElement.getAttribute("lang")).toBe("en");
  });

  it("has exactly one header, one labelled nav, and one main landmark", () => {
    const doc = parse(render());
    expect(doc.querySelectorAll("header").length).toBe(1);
    expect(doc.querySelectorAll("main").length).toBe(1);
    const navs = doc.querySelectorAll("nav");
    expect(navs.length).toBe(1);
    expect(navs[0]!.getAttribute("aria-label")).toBeTruthy();
  });

  it("starts the body with a skip link that targets main", () => {
    const doc = parse(render());
    const first = doc.body.firstElementChild!;
    expect(first.tagName.toLowerCase()).toBe("a");
    expect(first.getAttribute("class")).toBe("skip-link");
    const href = first.getAttribute("href")!;
    expect(href.startsWith("#")).toBe(true);
    const target = doc.getElementById(href.slice(1));
    expect(target).not.toBeNull();
    expect(target!.tagName.toLowerCase()).toBe("main");
    expect(first.textContent.trim().length).toBeGreaterThan(0);
  });

  it("keeps the skip link visually tucked away until it receives focus", () => {
    const style = css(render());
    expect(selectorsWith(style, "").some((s) => s === ".skip-link")).toBe(true);
    expect(style).toContain(".skip-link:focus");
    // Hidden by clipping, not display:none — it must stay focusable.
    for (const selector of selectorsWith(style, "display:none")) {
      expect(selector).not.toContain("skip-link");
    }
  });

  it("puts the sidebar (and its tab anchors) before main in focus order", () => {
    const doc = parse(render());
    const body = doc.body;
    const sidebarIndex = Array.from(body.querySelectorAll("*")).findIndex(
      (el) => el.getAttribute("class") === "sidebar"
    );
    const mainIndex = Array.from(body.querySelectorAll("*")).findIndex(
      (el) => el.tagName.toLowerCase() === "main"
    );
    expect(sidebarIndex).toBeGreaterThanOrEqual(0);
    expect(mainIndex).toBeGreaterThan(sidebarIndex);
  });
});

// ---------------------------------------------------------------------------
// Small screens: wrapping + sidebar collapse so 320px never scrolls sideways
// ---------------------------------------------------------------------------

describe("small-screen hardening (CSS-rule level; visual check manual)", () => {
  it("ships a responsive viewport meta", () => {
    const doc = parse(render());
    const meta = doc.querySelector('meta[name="viewport"]');
    expect(meta).not.toBeNull();
    expect(meta!.getAttribute("content")).toContain("width=device-width");
  });

  it("wraps long tokens in every prose context (overflow-wrap:anywhere)", () => {
    const selectors = selectorsWith(css(render()), "overflow-wrap:anywhere")
      .join(",")
      .split(",")
      .map((s) => s.trim());
    for (const needed of ["h1", "h2", "h3", "p", "li", "code", "summary", "label", "a"]) {
      expect(selectors, `missing overflow-wrap for ${needed}`).toContain(needed);
    }
  });

  it("collapses the sidebar to a horizontally scrollable tab row under 736px", () => {
    const style = css(render());
    expect(style).toContain("@media (max-width:735px)");
    const collapsed = style.slice(style.indexOf("@media (max-width:735px)"));
    expect(collapsed).toMatch(/\.tabs\{[^}]*overflow-x:auto/);
    expect(collapsed).toMatch(/\.layout\{[^}]*flex-direction:column/);
  });

  it("scales diagrams down and lets oversized ones scroll inside their figure", () => {
    const style = css(render());
    const svgRules = selectorsWith(style, "max-width:100%");
    expect(svgRules.some((s) => s.includes("svg"))).toBe(true);
    const figureRules = selectorsWith(style, "overflow-x:auto");
    expect(figureRules).toContain("figure.diagram");
  });

  it("declares no fixed pixel widths outside the visually-hidden helpers", () => {
    const style = css(render());
    for (const match of style.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const declarations = match[2]!;
      const widths = declarations.matchAll(/(?:^|;)\s*width:\s*(\d+)px/g);
      for (const width of widths) {
        // 1px is the visually-hidden clip pattern; anything larger risks
        // horizontal scroll at 320px.
        expect(Number(width[1])).toBeLessThanOrEqual(1);
      }
    }
  });

  it("keeps a hostile unbroken long token inside wrapped elements only", () => {
    const hostile = change();
    hostile.changeUnits[0]!.technicalTitle = LONG_TOKEN;
    hostile.changeUnits[0]!.summary = LONG_TOKEN;
    hostile.entities[0]!.humanLabel = LONG_TOKEN;
    const doc = parse(render(hostile));
    // The token may land only inside an element covered by the
    // overflow-wrap rules (overflow-wrap inherits, so an ancestor match
    // counts) or inside the SVG (which clips to its viewBox and scales
    // via max-width).
    const wrappedSelector = "h1,h2,h3,p,li,code,summary,label,a,figcaption";
    let found = 0;
    for (const el of Array.from(doc.querySelectorAll("*"))) {
      const ownText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join("");
      if (ownText.includes(LONG_TOKEN)) {
        found++;
        const tag = el.tagName.toLowerCase();
        const inWrapped = el.closest(wrappedSelector) !== null;
        const inSvg = el.closest("svg") !== null;
        expect(
          inWrapped || inSvg,
          `long token in unwrapped <${tag}>`
        ).toBe(true);
      }
    }
    expect(found).toBeGreaterThan(0);
  });
});
