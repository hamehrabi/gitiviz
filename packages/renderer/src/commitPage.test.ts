import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import type { ChangeUnit } from "@gitiviz/schema";
import type { CommitPageModel } from "./dashboardTypes.js";
import { commitPageCss, renderCommitPage } from "./commitPage.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function demoUnit(overrides: Partial<ChangeUnit> = {}): ChangeUnit {
  return {
    id: "unit-1",
    technicalTitle: "feat: add guest checkout route",
    humanTitle: "Guests can now check out",
    provenance: "inferred",
    commits: ["c".repeat(40)],
    evidence: [
      {
        path: "src/routes/orders.ts",
        range: { startLine: 3, endLine: 9 },
        symbol: "createOrder"
      }
    ],
    ...overrides
  };
}

function demoModel(overrides: Partial<CommitPageModel> = {}): CommitPageModel {
  return {
    anchorId: "u0",
    title: "Guests can now check out",
    titleInferred: true,
    purpose: "Guests no longer need an account to place an order.",
    before: "Only registered users could order.",
    after: "Guests can place orders too.",
    shortSha: "ccccccc",
    type: "feature",
    unchangedCount: 3,
    unit: demoUnit(),
    ...overrides
  };
}

const DIAGRAM_SVG =
  `<svg role="img" aria-label="Before and after" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>`;

function parse(html: string) {
  const window = new Window();
  window.document.body.innerHTML = html;
  const root = window.document.body.firstElementChild;
  if (root === null) throw new Error("render produced no root element");
  return { document: window.document, root };
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

describe("renderCommitPage structure", () => {
  it("renders a section root with the anchor id and cp-page class", () => {
    const { root } = parse(renderCommitPage(demoModel(), DIAGRAM_SVG));
    expect(root.tagName).toBe("SECTION");
    expect(root.getAttribute("id")).toBe("u0");
    expect(root.classList.contains("cp-page")).toBe(true);
  });

  it("orders content: meta, title, purpose, before/after, diagram, unchanged, back, evidence", () => {
    const { root } = parse(renderCommitPage(demoModel(), DIAGRAM_SVG));
    const classes = Array.from(root.children).map(
      (child) => child.classList[0]
    );
    expect(classes).toEqual([
      "cp-meta",
      "cp-title",
      "cp-purpose",
      "cp-beforeafter",
      "cp-diagram",
      "cp-unchanged",
      "cp-back",
      "cp-evidence"
    ]);
  });

  it("keeps the pre-fold budget: at most 8 direct children on the root", () => {
    const full = parse(renderCommitPage(demoModel(), DIAGRAM_SVG));
    expect(full.root.children.length).toBeLessThanOrEqual(8);
    const sparse = parse(renderCommitPage(demoModel({ purpose: null }), null));
    expect(sparse.root.children.length).toBeLessThanOrEqual(8);
  });

  it("labels Before and After rows in order with the narrated text", () => {
    const { root } = parse(renderCommitPage(demoModel(), DIAGRAM_SVG));
    const labels = Array.from(root.querySelectorAll(".cp-row dt")).map(
      (dt) => dt.textContent
    );
    expect(labels).toEqual(["Before", "After"]);
    const bodies = Array.from(root.querySelectorAll(".cp-row dd")).map(
      (dd) => dd.textContent
    );
    expect(bodies).toEqual([
      "Only registered users could order.",
      "Guests can place orders too."
    ]);
  });

  it("renders quiet placeholders for un-narrated before/after", () => {
    const { root } = parse(
      renderCommitPage(demoModel({ before: null, after: null }), null)
    );
    const placeholders = root.querySelectorAll(".cp-row .cp-not-narrated");
    expect(placeholders.length).toBe(2);
    expect(placeholders[0]?.textContent).toBe("Not narrated yet.");
  });

  it("omits the purpose paragraph when not narrated", () => {
    const { root } = parse(renderCommitPage(demoModel({ purpose: null }), null));
    expect(root.querySelector(".cp-purpose")).toBeNull();
  });

  it("shows the type tag and short sha, and omits the sha when absent", () => {
    const withSha = parse(renderCommitPage(demoModel(), null));
    expect(withSha.root.querySelector(".cp-tag")?.textContent).toBe("feature");
    expect(
      withSha.root.querySelector(".cp-tag")?.classList.contains("cp-tag-feature")
    ).toBe(true);
    expect(withSha.root.querySelector(".cp-sha")?.textContent).toBe("ccccccc");
    const noSha = parse(renderCommitPage(demoModel({ shortSha: null }), null));
    expect(noSha.root.querySelector(".cp-sha")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

describe("renderCommitPage provenance", () => {
  it("marks a narrated title with the ◇ glyph plus title text", () => {
    const { root } = parse(renderCommitPage(demoModel(), null));
    const mark = root.querySelector(".cp-title .prov");
    expect(mark?.textContent).toBe("◇");
    expect(mark?.getAttribute("title")).toContain("AI interpretation");
  });

  it("omits the ◇ mark for derived titles", () => {
    const { root } = parse(
      renderCommitPage(demoModel({ titleInferred: false }), null)
    );
    expect(root.querySelector(".cp-title .prov")).toBeNull();
  });

  it("marks evidence lines with the ✓ derived glyph", () => {
    const { root } = parse(renderCommitPage(demoModel(), null));
    const marks = root.querySelectorAll(".cp-evidence .prov");
    expect(marks.length).toBeGreaterThan(0);
    expect(marks[0]?.textContent).toBe("✓");
    expect(marks[0]?.getAttribute("title")).toContain("Derived");
  });
});

// ---------------------------------------------------------------------------
// Diagram slot
// ---------------------------------------------------------------------------

describe("renderCommitPage diagram", () => {
  it("inserts trusted diagram SVG verbatim inside the figure", () => {
    const html = renderCommitPage(demoModel(), DIAGRAM_SVG);
    expect(html).toContain(DIAGRAM_SVG);
    const { root } = parse(html);
    expect(root.querySelector(".cp-diagram svg")).not.toBeNull();
  });

  it("renders a quiet placeholder when there is no diagram", () => {
    const { root } = parse(renderCommitPage(demoModel(), null));
    expect(root.querySelector(".cp-diagram svg")).toBeNull();
    expect(root.querySelector(".cp-no-diagram")?.textContent).toBe(
      "No diagram for this change."
    );
  });

  it("never emits a Diagram source fold — the mermaid text stays out of the page", () => {
    const html = renderCommitPage(demoModel(), DIAGRAM_SVG, {
      fallbackNote: "note",
      evidenceSvg: DIAGRAM_SVG
    });
    expect(html).not.toContain("Diagram source");
    expect(html).not.toContain("cp-source");
    const { root } = parse(html);
    expect(root.querySelector(".cp-diagram details")).toBeNull();
  });

  it("shows the honest fallback note inside the figure when provided", () => {
    const { root } = parse(
      renderCommitPage(demoModel(), DIAGRAM_SVG, {
        fallbackNote: "Rendered with the built-in diagram engine."
      })
    );
    const note = root.querySelector(".cp-diagram figcaption");
    expect(note).not.toBeNull();
    expect(note!.textContent).toBe("Rendered with the built-in diagram engine.");
  });

  it("keeps the child budget with all extras present", () => {
    const { root } = parse(
      renderCommitPage(demoModel(), DIAGRAM_SVG, {
        fallbackNote: "note",
        evidenceSvg: DIAGRAM_SVG
      })
    );
    expect(root.children.length).toBeLessThanOrEqual(8);
  });

  it("places the full-graph SVG only inside the technical evidence fold", () => {
    const evidenceSvg = `<svg role="img" aria-label="full-graph" viewBox="0 0 10 10"></svg>`;
    const { root } = parse(
      renderCommitPage(demoModel(), DIAGRAM_SVG, { evidenceSvg })
    );
    const inEvidence = root.querySelector('.cp-evidence svg[aria-label="full-graph"]');
    expect(inEvidence).not.toBeNull();
    expect(root.querySelectorAll('svg[aria-label="full-graph"]').length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Folds
// ---------------------------------------------------------------------------

describe("renderCommitPage folds", () => {
  it("keeps every fold closed by default", () => {
    const html = renderCommitPage(demoModel(), DIAGRAM_SVG);
    expect(html).not.toContain("<details open");
    const { root } = parse(html);
    const details = root.querySelectorAll("details");
    expect(details.length).toBe(2);
    for (const fold of Array.from(details)) {
      expect(fold.hasAttribute("open")).toBe(false);
    }
  });

  it("counts unchanged components with correct pluralization", () => {
    const many = parse(renderCommitPage(demoModel(), null));
    expect(many.root.querySelector(".cp-unchanged summary")?.textContent).toBe(
      "Unchanged: 3 components"
    );
    const one = parse(renderCommitPage(demoModel({ unchangedCount: 1 }), null));
    expect(one.root.querySelector(".cp-unchanged summary")?.textContent).toBe(
      "Unchanged: 1 component"
    );
  });

  it("omits the unchanged fold when the count is zero", () => {
    const { root } = parse(
      renderCommitPage(demoModel({ unchangedCount: 0 }), null)
    );
    expect(root.querySelector(".cp-unchanged")).toBeNull();
  });

  it("folds technical evidence: raw subject, commit sha, anchors", () => {
    const { root } = parse(renderCommitPage(demoModel(), null));
    const evidence = root.querySelector(".cp-evidence");
    expect(evidence?.querySelector("summary")?.textContent).toBe(
      "Technical evidence"
    );
    expect(evidence?.textContent).toContain("feat: add guest checkout route");
    expect(evidence?.textContent).toContain("ccccccc");
    expect(evidence?.textContent).toContain("src/routes/orders.ts");
    expect(evidence?.textContent).toContain("lines 3–9");
    expect(evidence?.textContent).toContain("createOrder");
  });

  it("says so when a unit has no recorded evidence", () => {
    const model = demoModel({
      unit: demoUnit({ commits: undefined, evidence: undefined })
    });
    const { root } = parse(renderCommitPage(model, null));
    expect(root.querySelector(".cp-ev-empty")?.textContent).toBe(
      "No recorded evidence for this change."
    );
  });
});

// ---------------------------------------------------------------------------
// Back link
// ---------------------------------------------------------------------------

describe("renderCommitPage back link", () => {
  it("renders a prominent back link that clears the fragment", () => {
    const { root } = parse(renderCommitPage(demoModel(), null));
    const link = root.querySelector("a.cp-back-link");
    expect(link?.getAttribute("href")).toBe("#");
    expect(link?.textContent).toBe("← All changes");
  });
});

// ---------------------------------------------------------------------------
// Escaping (the analyzed repository is hostile input)
// ---------------------------------------------------------------------------

describe("renderCommitPage escaping", () => {
  const hostileModel = (): CommitPageModel =>
    demoModel({
      title: `<script>alert(1)</script>`,
      purpose: `"><img src=x onerror=alert(2)>`,
      before: `<b onmouseover="x">bold</b>`,
      after: `</dd></dl><script>alert(3)</script>`,
      shortSha: `"><svg`,
      unit: demoUnit({
        technicalTitle: `feat: <script>alert(4)</script>`,
        commits: [`e".repeat`.padEnd(40, "e")],
        evidence: [{ path: `src/<script>.ts`, symbol: `a"b<c>` }]
      })
    });

  it("never lets repo strings become markup", () => {
    const html = renderCommitPage(hostileModel(), null);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b ");
    const { root } = parse(html);
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("img")).toBeNull();
  });

  it("round-trips hostile text as visible text content", () => {
    const { root } = parse(renderCommitPage(hostileModel(), null));
    expect(root.querySelector(".cp-title")?.textContent).toContain(
      "<script>alert(1)</script>"
    );
    expect(root.querySelector(".cp-purpose")?.textContent).toBe(
      `"><img src=x onerror=alert(2)>`
    );
    expect(root.querySelector(".cp-evidence")?.textContent).toContain(
      "src/<script>.ts"
    );
  });

  it("keeps the before/after structure intact under breakout attempts", () => {
    const { root } = parse(renderCommitPage(hostileModel(), null));
    expect(root.querySelectorAll(".cp-row").length).toBe(2);
    expect(root.querySelectorAll(".cp-beforeafter").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Determinism and CSS discipline
// ---------------------------------------------------------------------------

describe("renderCommitPage output discipline", () => {
  it("is deterministic: identical input produces byte-identical output", () => {
    const a = renderCommitPage(demoModel(), DIAGRAM_SVG);
    const b = renderCommitPage(demoModel(), DIAGRAM_SVG);
    expect(a).toBe(b);
  });

  it("emits no <style> or <script> tags of its own", () => {
    const html = renderCommitPage(demoModel(), DIAGRAM_SVG);
    expect(html).not.toContain("<style");
    expect(html).not.toContain("<script");
  });

  it("scopes every CSS class selector to the cp- prefix", () => {
    const selectors = commitPageCss.match(/\.[A-Za-z][\w-]*/g) ?? [];
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector.startsWith(".cp-")).toBe(true);
    }
  });

  it("keeps commitPageCss free of scripts and external references", () => {
    expect(commitPageCss).not.toContain("url(");
    expect(commitPageCss).not.toContain("@import");
    expect(commitPageCss).not.toContain("javascript:");
  });
});
