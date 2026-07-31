/**
 * Tests for the Home cards module (cards.ts) — agent B.
 *
 * Covered per the module contract: one card per unit, the CSS-only filter
 * selector wiring, narrated-title + ◇ provenance behaviour (through the
 * real toCardModel mapping), hostile-input escaping, and determinism.
 */

import { describe, expect, it } from "vitest";
import type { ChangeManifest, ChangeUnit } from "@gitiviz/schema";
import { cardsCss, renderCardsGrid, renderFilterChips } from "./cards.js";
import { toCardModel, type CardModel } from "./dashboardTypes.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function unit(overrides: Partial<ChangeUnit> = {}): ChangeUnit {
  return {
    id: "unit-1",
    technicalTitle: "feat(api): add session endpoints",
    provenance: "derived",
    ...overrides
  };
}

function manifest(units: ChangeUnit[]): ChangeManifest {
  return {
    specVersion: "0.1.0",
    repository: { name: "demo" },
    baseRevision: "a".repeat(40),
    headRevision: "b".repeat(40),
    entities: [],
    relationships: [],
    changeUnits: units,
    analysisLimitations: []
  };
}

function card(overrides: Partial<CardModel> = {}): CardModel {
  return {
    unitId: "unit-1",
    href: "#u0",
    title: "Sign-in sessions arrive",
    titleInferred: false,
    summary: "Users can now stay signed in between visits.",
    shortSha: "abc1234",
    type: "feature",
    chapters: [{ id: "systems", label: "Systems" }],
    ...overrides
  };
}

const COMMIT_TYPES = ["feature", "fix", "docs", "test", "housekeeping"] as const;

// ---------------------------------------------------------------------------
// Cards grid
// ---------------------------------------------------------------------------

describe("renderCardsGrid", () => {
  it("renders exactly one anchor card per unit, in order, with the unit's href", () => {
    const html = renderCardsGrid([
      card({ href: "#u0", title: "First" }),
      card({ href: "#u1", title: "Second", type: "fix" }),
      card({ href: "#u2", title: "Third", type: "housekeeping" })
    ]);
    expect(html.match(/<a class="cd-card /g)).toHaveLength(3);
    expect(html.indexOf('href="#u0"')).toBeGreaterThan(-1);
    expect(html.indexOf('href="#u0"')).toBeLessThan(html.indexOf('href="#u1"'));
    expect(html.indexOf('href="#u1"')).toBeLessThan(html.indexOf('href="#u2"'));
  });

  it("renders title, summary, short sha, type tag, and chapter chips on a card", () => {
    const html = renderCardsGrid([card()]);
    expect(html).toContain('<h3 class="cd-title">Sign-in sessions arrive</h3>');
    expect(html).toContain(
      '<p class="cd-summary">Users can now stay signed in between visits.</p>'
    );
    expect(html).toContain('<code class="cd-sha">abc1234</code>');
    expect(html).toContain('class="cd-card cd-type-feature"');
    expect(html).toContain('<span class="cd-tag cd-tag-feature">Feature</span>');
    expect(html).toContain('<span class="cd-chapter">Systems</span>');
  });

  it("omits summary, sha, and chapter row when the model has none", () => {
    const html = renderCardsGrid([
      card({ summary: null, shortSha: null, chapters: [] })
    ]);
    expect(html).not.toContain("cd-summary");
    expect(html).not.toContain("cd-sha");
    expect(html).not.toContain("cd-chapters");
  });

  it("uses the narrated title with the ◇ provenance mark when inferred", () => {
    const model = toCardModel(
      unit({
        provenance: "inferred",
        confidence: 0.9,
        humanTitle: "Sign-in sessions arrive"
      }),
      0,
      manifest([])
    );
    const html = renderCardsGrid([model]);
    expect(html).toContain("Sign-in sessions arrive");
    expect(html).not.toContain("feat(api): add session endpoints");
    expect(html).toContain('class="prov"');
    expect(html).toContain("◇");
  });

  it("falls back to the technical title without ◇ when not narrated", () => {
    const model = toCardModel(unit(), 0, manifest([]));
    const html = renderCardsGrid([model]);
    expect(html).toContain("feat(api): add session endpoints");
    expect(html).not.toContain("◇");
    expect(html).not.toContain('class="prov"');
  });

  it("escapes hostile titles, summaries, shas, and chip labels", () => {
    const html = renderCardsGrid([
      card({
        title: `<script>alert(1)</script>`,
        summary: `"><img src=x onerror=alert(2)>`,
        shortSha: `<b>sha</b>`,
        chapters: [{ id: "systems", label: `<i>Systems</i>` }]
      })
    ]);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<i>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(2)&gt;");
  });

  it("renders an empty grid container for zero units", () => {
    expect(renderCardsGrid([])).toBe('<div class="cd-grid"></div>');
  });

  it("never emits a <style> tag", () => {
    expect(renderCardsGrid([card()])).not.toContain("<style");
    expect(renderFilterChips([...COMMIT_TYPES])).not.toContain("<style");
  });

  it("is deterministic: identical input produces byte-identical output", () => {
    const models = [card(), card({ href: "#u1", type: "docs" })];
    expect(renderCardsGrid(models)).toBe(renderCardsGrid(models));
  });
});

// ---------------------------------------------------------------------------
// Filter chips
// ---------------------------------------------------------------------------

describe("renderFilterChips", () => {
  it('renders "All" (checked) plus one radio+label pair per type, in order', () => {
    const html = renderFilterChips(["feature", "fix"]);
    expect(html).toContain(
      '<input type="radio" name="cd-filter" id="cd-filter-all" class="cd-filter-input" checked>'
    );
    expect(html).toContain('id="cd-filter-feature"');
    expect(html).toContain('id="cd-filter-fix"');
    expect(html).toContain('<label class="cd-chip" for="cd-filter-all">All</label>');
    expect(html).toContain('<label class="cd-chip" for="cd-filter-feature">Feature</label>');
    expect(html).toContain('<label class="cd-chip" for="cd-filter-fix">Fix</label>');
    // Only "All" starts checked.
    expect(html.match(/ checked>/g)).toHaveLength(1);
    expect(html.indexOf("cd-filter-feature")).toBeLessThan(
      html.indexOf("cd-filter-fix")
    );
  });

  it("emits the radios before the .cd-filters row so ~ can reach labels and grid", () => {
    const html = renderFilterChips(["feature"]);
    expect(html.startsWith("<input")).toBe(true);
    expect(html.indexOf('id="cd-filter-feature"')).toBeLessThan(
      html.indexOf('class="cd-filters"')
    );
  });

  it("is deterministic", () => {
    expect(renderFilterChips(["feature", "docs"])).toBe(
      renderFilterChips(["feature", "docs"])
    );
  });
});

// ---------------------------------------------------------------------------
// CSS contract
// ---------------------------------------------------------------------------

describe("cardsCss", () => {
  it("contains the sibling show/hide selector for every commit type", () => {
    for (const type of COMMIT_TYPES) {
      expect(cardsCss).toContain(
        `#cd-filter-${type}:checked~.cd-grid .cd-card:not(.cd-type-${type}){display:none}`
      );
    }
  });

  it("lights the active chip (including All) and shows keyboard focus on it", () => {
    for (const id of ["all", ...COMMIT_TYPES]) {
      expect(cardsCss).toContain(
        `#cd-filter-${id}:checked~.cd-filters .cd-chip[for="cd-filter-${id}"]{`
      );
      expect(cardsCss).toContain(
        `#cd-filter-${id}:focus-visible~.cd-filters .cd-chip[for="cd-filter-${id}"]{`
      );
    }
  });

  it("hides the radios accessibly — clipped, never display:none", () => {
    const inputRule = cardsCss
      .split("\n")
      .find((line) => line.startsWith(".cd-filter-input{"));
    expect(inputRule).toBeDefined();
    expect(inputRule).toContain("clip-path:inset(50%)");
    expect(inputRule).not.toContain("display:none");
  });

  it("has a tag tint for every commit type and no <style> wrapper", () => {
    for (const type of COMMIT_TYPES) {
      expect(cardsCss).toContain(`.cd-tag-${type}{`);
    }
    expect(cardsCss).not.toContain("<style");
  });
});
