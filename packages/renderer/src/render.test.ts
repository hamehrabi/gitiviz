import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import type { BookManifest, ChangeManifest } from "@gitiviz/schema";
import { CHAPTER_IDS, validateBookManifest, validateChangeManifest } from "@gitiviz/schema";
import { renderChangeBook, type DiagramRequest } from "./render.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function demoChange(): ChangeManifest {
  return {
    specVersion: "0.1.0",
    repository: { name: "demo-app" },
    baseRevision: "a".repeat(40),
    headRevision: "b".repeat(40),
    entities: [
      {
        id: "ent-route",
        kind: "route",
        humanLabel: "Create order endpoint",
        technicalLabel: "POST /orders",
        baseState: "unchanged",
        headState: "added",
        provenance: "derived",
        evidence: [{ path: "src/routes/orders.ts", range: { startLine: 3, endLine: 9 } }]
      },
      {
        id: "ent-service",
        kind: "module",
        humanLabel: "Order service",
        technicalLabel: "src/services/orderService.ts",
        baseState: "unchanged",
        headState: "changed",
        provenance: "derived",
        evidence: [{ path: "src/services/orderService.ts" }]
      },
      {
        id: "ent-db",
        kind: "sql-table",
        humanLabel: "Orders table",
        baseState: "unchanged",
        headState: "unchanged",
        provenance: "derived",
        evidence: [{ path: "src/db/schema.sql" }]
      }
    ],
    relationships: [
      {
        id: "rel-1",
        from: "ent-route",
        to: "ent-service",
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
        humanTitle: "Guests can now check out",
        summary: "Adds a POST /orders route with validation.",
        beforeDescription: "Only registered users could order.",
        afterDescription: "Guests can place orders too.",
        userImpact: "Guests no longer need an account.",
        commits: ["c".repeat(40)],
        entities: ["ent-route", "ent-service"],
        relationships: ["rel-1"],
        provenance: "derived",
        evidence: [{ path: "src/routes/orders.ts" }]
      },
      {
        id: "unit-2",
        technicalTitle: "refactor: rename order helpers",
        commits: ["d".repeat(40)],
        entities: ["ent-service"],
        provenance: "derived"
      },
      {
        id: "unit-3",
        technicalTitle: "fixup! feat: add guest checkout route",
        grouped: true,
        groupedReason: "fixup commit",
        commits: ["e".repeat(40)],
        provenance: "derived"
      }
    ],
    analysisLimitations: [{ message: "No AST parse in v0.1; imports are regex-derived." }]
  };
}

function hostileChange(): ChangeManifest {
  const m = demoChange();
  m.repository.name = '<script>alert("repo")</script>';
  m.entities[0] = {
    ...m.entities[0],
    humanLabel: "<img src=x onerror=alert(1)>.ts",
    technicalLabel: '"><script>steal()</script>',
    evidence: [{ path: '<img src=x onerror=alert(1)>.ts', symbol: '"><script>' }]
  };
  m.changeUnits[0] = {
    ...m.changeUnits[0],
    humanTitle: '</section><script>alert(2)</script>',
    summary: 'See javascript:alert(1) & <a href="javascript:alert(1)">here</a>'
  };
  return m;
}

function demoBook(change: ChangeManifest): BookManifest {
  return {
    specVersion: "0.1.0",
    repository: { name: change.repository.name },
    chapters: CHAPTER_IDS.map((id) => ({
      id,
      title: `Title for ${id}`,
      status: id === "purpose" || id === "systems" || id === "history" ? "generated" : "not-written"
    }))
  };
}

function renderDemo(options?: Parameters<typeof renderChangeBook>[2]): string {
  const change = demoChange();
  return renderChangeBook(demoBook(change), change, options);
}

function parse(html: string) {
  const window = new Window();
  const parser = new window.DOMParser();
  return parser.parseFromString(html, "text/html");
}

function styleOf(html: string): string {
  return parse(html).querySelector("style")!.textContent;
}

const TAB_HREFS = ["#home", "#overview", "#architecture", "#how-it-works", "#more"];

// ---------------------------------------------------------------------------
// Fixture sanity — the fixtures must be schema-valid or the tests test nothing.
// ---------------------------------------------------------------------------

describe("fixtures", () => {
  it("are schema-valid", () => {
    expect(validateChangeManifest(demoChange()).ok).toBe(true);
    expect(validateChangeManifest(hostileChange()).ok).toBe(true);
    expect(validateBookManifest(demoBook(demoChange())).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Document shell
// ---------------------------------------------------------------------------

describe("renderChangeBook document shell", () => {
  it("emits a complete standalone HTML document", () => {
    const html = renderDemo();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charset="utf-8"');
  });

  it("carries the strict no-script CSP", () => {
    const doc = parse(renderDemo());
    const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
    expect(csp).not.toBeNull();
    expect(csp!.getAttribute("content")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:;"
    );
  });

  it("contains zero script tags", () => {
    const doc = parse(renderDemo());
    expect(doc.querySelectorAll("script").length).toBe(0);
  });

  it("contains no http:// references", () => {
    expect(renderDemo()).not.toContain("http://");
  });

  it("contains no event-handler attributes", () => {
    const doc = parse(renderDemo());
    for (const el of Array.from(doc.querySelectorAll("*"))) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.name.startsWith("on")).toBe(false);
      }
    }
  });

  it("stays byte-deterministic", () => {
    expect(renderDemo()).toBe(renderDemo());
  });
});

// ---------------------------------------------------------------------------
// Sidebar: wordmark + tab nav
// ---------------------------------------------------------------------------

describe("sidebar", () => {
  it("puts the wordmark masthead inside the sidebar", () => {
    const doc = parse(renderDemo());
    const sidebar = doc.querySelector("aside.sidebar");
    expect(sidebar).not.toBeNull();
    const header = sidebar!.querySelector("header.masthead");
    expect(header).not.toBeNull();
    expect(header!.querySelector(".masthead-kicker")!.textContent).toBe("Change book");
    expect(header!.querySelector("h1")!.textContent).toBe("demo-app");
    const subtitle = header!.querySelector(".subtitle")!;
    expect(subtitle.textContent).toContain("2 changes");
    expect(subtitle.textContent).toContain("aaaaaaaaaa → bbbbbbbbbb");
  });

  it("renders the shortened SHAs as secondary .rev spans, never raw 40-char SHAs", () => {
    const doc = parse(renderDemo());
    const revs = doc.querySelectorAll("header .subtitle .rev");
    expect(revs.length).toBe(2);
    expect(revs[0]!.textContent).toBe("aaaaaaaaaa");
    expect(revs[1]!.textContent).toBe("bbbbbbbbbb");
    expect(doc.querySelector("header")!.textContent).not.toContain("a".repeat(40));
  });

  it("prefers the repoName option for the display name and document title", () => {
    const change = demoChange();
    const doc = parse(
      renderChangeBook(demoBook(change), change, { repoName: "Demo App" })
    );
    expect(doc.querySelector("header h1")!.textContent).toBe("Demo App");
    expect(doc.querySelector("title")!.textContent).toBe("Demo App — change book");
  });

  it("escapes a hostile repoName option", () => {
    const change = demoChange();
    const html = renderChangeBook(demoBook(change), change, {
      repoName: "<script>alert(1)</script>"
    });
    expect(html).not.toContain("<script>alert");
    expect(parse(html).querySelectorAll("script").length).toBe(0);
  });

  it("is sticky on wide screens and collapses to a scrollable tab row under 736px", () => {
    const css = styleOf(renderDemo());
    expect(css).toMatch(/\.sidebar\{[^}]*position:sticky/);
    expect(css).toContain("@media (max-width:735px)");
    const collapsed = css.slice(css.indexOf("@media (max-width:735px)"));
    expect(collapsed).toMatch(/\.tabs\{[^}]*overflow-x:auto/);
    expect(collapsed).toMatch(/\.sidebar\{[^}]*position:static/);
  });
});

describe("tab navigation", () => {
  it("renders the five view tabs, in order, as plain anchors", () => {
    const doc = parse(renderDemo());
    const nav = doc.querySelector("nav.tabs");
    expect(nav).not.toBeNull();
    expect(nav!.getAttribute("aria-label")).toBeTruthy();
    const tabs = Array.from(nav!.querySelectorAll("a"));
    expect(tabs.map((a) => a.getAttribute("href"))).toEqual(TAB_HREFS);
    expect(tabs.map((a) => a.textContent)).toEqual([
      "Home",
      "Overview",
      "Architecture",
      "How it works",
      "More"
    ]);
  });

  it("points every tab at a real section id", () => {
    const doc = parse(renderDemo());
    for (const a of Array.from(doc.querySelectorAll("nav.tabs a"))) {
      const target = doc.getElementById(a.getAttribute("href")!.slice(1));
      expect(target, `dangling tab ${a.getAttribute("href")}`).not.toBeNull();
      expect(target!.tagName.toLowerCase()).toBe("section");
    }
  });

  it("shows home by default and any :target section instead (pure CSS)", () => {
    const css = styleOf(renderDemo());
    expect(css).toContain("main>section{display:none");
    expect(css).toContain("main>section:target{display:block}");
    expect(css).toContain("#home{display:block}");
    // Sibling technique: home is the LAST section, hidden when any earlier
    // section is targeted. Degrades without :has support.
    expect(css).toContain("main>section:target~#home{display:none}");
  });

  it("keeps home as the last section so the sibling hide rule can reach it", () => {
    const doc = parse(renderDemo());
    const sections = Array.from(doc.querySelectorAll("main > section"));
    expect(sections.length).toBeGreaterThan(1);
    expect(sections[sections.length - 1]!.getAttribute("id")).toBe("home");
  });

  it("marks the current tab active: home by default, :has-based otherwise", () => {
    const css = styleOf(renderDemo());
    expect(css).toMatch(/\.tabs a\[href="#home"\]\{[^}]*background:#eff6ff/);
    // Progressive enhancement: browsers without :has simply keep Home lit.
    expect(css).toContain(
      'body:has(#overview:target,#architecture:target,#how-it-works:target,#more:target) .tabs a[href="#home"]'
    );
    for (const id of ["overview", "architecture", "how-it-works", "more"]) {
      expect(css).toContain(`body:has(#${id}:target) .tabs a[href="#${id}"]`);
    }
  });
});

// ---------------------------------------------------------------------------
// Home: commit cards grid
// ---------------------------------------------------------------------------

describe("home cards grid", () => {
  it("renders one card per meaningful change unit; grouped commits get none", () => {
    const doc = parse(renderDemo());
    const cards = doc.querySelectorAll("#home .grid .card");
    expect(cards.length).toBe(2);
    expect(doc.querySelector("#home")!.textContent).not.toContain("fixup!");
  });

  it("shows the narrated human title, falling back to the technical title", () => {
    const doc = parse(renderDemo());
    const titles = Array.from(doc.querySelectorAll("#home .card .card-title")).map(
      (t) => t.textContent.trim()
    );
    expect(titles).toEqual([
      "Guests can now check out",
      "refactor: rename order helpers"
    ]);
  });

  it("shows a one-line summary when narrated, and the short sha", () => {
    const doc = parse(renderDemo());
    const cards = Array.from(doc.querySelectorAll("#home .card"));
    expect(cards[0]!.querySelector(".card-summary")!.textContent).toBe(
      "Adds a POST /orders route with validation."
    );
    expect(cards[1]!.querySelector(".card-summary")).toBeNull();
    expect(cards[0]!.querySelector("code.card-sha")!.textContent).toBe("ccccccc");
    expect(cards[1]!.querySelector("code.card-sha")!.textContent).toBe("ddddddd");
  });

  it("derives the type tag from the conventional-commit prefix", () => {
    const doc = parse(renderDemo());
    const cards = Array.from(doc.querySelectorAll("#home .card"));
    expect(cards[0]!.querySelector(".tag")!.textContent).toBe("feature");
    expect(cards[0]!.getAttribute("class")).toContain("type-feature");
    // refactor: falls into the housekeeping bucket.
    expect(cards[1]!.querySelector(".tag")!.textContent).toBe("housekeeping");
    expect(cards[1]!.getAttribute("class")).toContain("type-housekeeping");
  });

  it("shows affected-chapter chips derived from what the unit touches", () => {
    const doc = parse(renderDemo());
    const cards = Array.from(doc.querySelectorAll("#home .card"));
    const chipTexts = cards.map((card) =>
      Array.from(card.querySelectorAll(".chip")).map((c) => c.textContent)
    );
    // unit-1 touches entities (systems), a relationship (flows), a route
    // (contracts); unit-2 touches only a module entity.
    expect(chipTexts).toEqual([["Systems", "Flows", "Contracts"], ["Systems"]]);
  });

  it("marks narrated cards with the ◇ provenance glyph", () => {
    const change = demoChange();
    change.changeUnits[0]!.provenance = "inferred";
    const doc = parse(renderChangeBook(demoBook(change), change));
    const card = doc.querySelector("#home .card")!;
    const prov = card.querySelector(".prov");
    expect(prov).not.toBeNull();
    expect(prov!.textContent).toBe("◇");
    expect(prov!.getAttribute("title")).toContain("AI interpretation");
  });

  it("says so plainly when there are no meaningful changes", () => {
    const change = demoChange();
    change.changeUnits = change.changeUnits.filter((u) => u.grouped);
    const doc = parse(renderChangeBook(demoBook(change), change));
    const home = doc.querySelector("#home")!;
    expect(home.querySelectorAll(".card").length).toBe(0);
    expect(home.querySelectorAll('input[name="filter"]').length).toBe(0);
    expect(home.textContent).toContain("No meaningful changes");
  });
});

// ---------------------------------------------------------------------------
// Home: CSS-only filter chips
// ---------------------------------------------------------------------------

describe("filter chips (scriptless)", () => {
  it('offers "All" plus exactly the commit types present', () => {
    const doc = parse(renderDemo());
    const labels = Array.from(doc.querySelectorAll("#home .filters label")).map(
      (l) => l.textContent
    );
    expect(labels).toEqual(["All", "feature", "housekeeping"]);
  });

  it("uses radio inputs preceding the grid so sibling selectors can filter", () => {
    const doc = parse(renderDemo());
    const home = doc.querySelector("#home")!;
    const children = Array.from(home.children);
    const radios = children.filter((el) => el.tagName.toLowerCase() === "input");
    expect(radios.map((r) => r.getAttribute("id"))).toEqual([
      "f-all",
      "f-feature",
      "f-housekeeping"
    ]);
    for (const radio of radios) {
      expect(radio.getAttribute("type")).toBe("radio");
      expect(radio.getAttribute("name")).toBe("filter");
    }
    expect(
      radios.filter((r) => r.hasAttribute("checked")).map((r) => r.getAttribute("id"))
    ).toEqual(["f-all"]);
    // Document order: radios, then chips, then the grid — the CSS depends on it.
    const kinds = children.map((el) =>
      el.tagName.toLowerCase() === "input" ? "input" : el.getAttribute("class") ?? ""
    );
    expect(kinds.lastIndexOf("input")).toBeLessThan(kinds.indexOf("filters"));
    expect(kinds.indexOf("filters")).toBeLessThan(kinds.indexOf("grid"));
  });

  it("binds every chip label to a real filter radio", () => {
    const doc = parse(renderDemo());
    for (const label of Array.from(doc.querySelectorAll("#home .filters label"))) {
      const target = doc.getElementById(label.getAttribute("for")!);
      expect(target).not.toBeNull();
      expect(target!.getAttribute("name")).toBe("filter");
    }
  });

  it("hides non-matching cards via sibling selectors when a type is checked", () => {
    const css = styleOf(renderDemo());
    for (const type of ["feature", "housekeeping"]) {
      expect(css).toContain(
        `#f-${type}:checked~.grid .card:not(.type-${type}){display:none}`
      );
    }
    // No hide rule for All — everything stays visible.
    expect(css).not.toContain("#f-all:checked~.grid");
  });

  it("gives the checked chip an active state and a focus ring", () => {
    const css = styleOf(renderDemo());
    for (const id of ["f-all", "f-feature", "f-housekeeping"]) {
      expect(css).toContain(`#${id}:checked~.filters label[for="${id}"]`);
      expect(css).toContain(`#${id}:focus-visible~.filters label[for="${id}"]{outline:`);
    }
  });
});

// ---------------------------------------------------------------------------
// Overview view
// ---------------------------------------------------------------------------

describe("overview view", () => {
  it("summarizes repo, revisions, and meaningful change count under its question", () => {
    const doc = parse(renderDemo());
    const overview = doc.querySelector("#overview")!;
    expect(overview.querySelector("h2")!.textContent).toBe("Overview");
    expect(overview.querySelector(".view-sub")!.textContent).toBe(
      "What changed, and why does it matter?"
    );
    expect(overview.textContent).toContain("demo-app");
    expect(overview.textContent).toContain("2 meaningful changes");
    expect(overview.textContent).toContain("aaaaaaaaaa");
  });

  it("shows one timeline node per meaningful unit using the narrated title", () => {
    const doc = parse(renderDemo());
    const titles = Array.from(
      doc.querySelector("#overview ol.timeline")!.querySelectorAll(".timeline-title")
    ).map((t) => t.textContent);
    expect(titles).toEqual([
      "Guests can now check out",
      "refactor: rename order helpers"
    ]);
    const shas = Array.from(
      doc.querySelector("#overview ol.timeline")!.querySelectorAll("code.timeline-sha")
    ).map((c) => c.textContent);
    expect(shas).toContain("ccccccc");
    for (const sha of shas) expect(sha.length).toBe(7);
  });

  it("collapses grouped commits under a closed housekeeping details element", () => {
    const doc = parse(renderDemo());
    const overview = doc.querySelector("#overview")!;
    const housekeeping = overview.querySelector("details.housekeeping");
    expect(housekeeping).not.toBeNull();
    expect(housekeeping!.hasAttribute("open")).toBe(false);
    expect(housekeeping!.querySelector("summary")!.textContent).toBe(
      "1 housekeeping commit"
    );
    expect(housekeeping!.textContent).toContain("fixup! feat: add guest checkout route");
    expect(overview.querySelector("ol.timeline")!.textContent).not.toContain("fixup!");
  });

  it("keeps analysis limitations collapsed", () => {
    const doc = parse(renderDemo());
    const overview = doc.querySelector("#overview")!;
    const details = Array.from(overview.querySelectorAll("details")).find((d) =>
      d.textContent.includes("regex-derived")
    );
    expect(details).toBeDefined();
    expect(details!.hasAttribute("open")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Architecture and How-it-works views
// ---------------------------------------------------------------------------

describe("architecture view", () => {
  it("carries the systems diagram, entities, and connections", () => {
    const doc = parse(renderDemo());
    const section = doc.querySelector("#architecture")!;
    expect(section.querySelector("h2")!.textContent).toBe("Architecture");
    expect(section.querySelector("figure.diagram, figure.diagram-placeholder")).not.toBeNull();
    expect(section.textContent).toContain("Create order endpoint");
    expect(section.textContent).toContain("creates order via");
  });

  it("says not yet written when the systems chapter is not generated", () => {
    const change = demoChange();
    const book = demoBook(change);
    book.chapters = book.chapters.map((c) =>
      c.id === "systems" ? { ...c, status: "not-written" as const } : c
    );
    const doc = parse(renderChangeBook(book, change));
    expect(doc.querySelector("#architecture")!.textContent).toContain("Not yet written");
  });
});

describe("how it works view", () => {
  it("lists how value moves as verb sentences", () => {
    const doc = parse(renderDemo());
    const section = doc.querySelector("#how-it-works")!;
    expect(section.querySelector("h2")!.textContent).toBe("How it works");
    expect(section.textContent).toContain(
      "Create order endpoint —creates order via→ Order service"
    );
  });

  it("is honest when there are no derived flows", () => {
    const change = demoChange();
    change.relationships = [];
    const doc = parse(renderChangeBook(demoBook(change), change));
    expect(doc.querySelector("#how-it-works")!.textContent).toContain("Not yet written");
  });
});

// ---------------------------------------------------------------------------
// More view: remaining book chapters as folds
// ---------------------------------------------------------------------------

describe("more view", () => {
  it("folds the remaining seven book chapters into closed details", () => {
    const doc = parse(renderDemo());
    const folds = Array.from(doc.querySelectorAll("#more details.fold"));
    expect(folds.length).toBe(7);
    for (const fold of folds) expect(fold.hasAttribute("open")).toBe(false);
    const summaries = folds.map((f) => f.querySelector("summary")!.textContent);
    expect(summaries).toEqual([
      "Title for journeys",
      "Title for capabilities",
      "Title for contracts",
      "Title for security",
      "Title for operations",
      "Title for decisions",
      "Title for history"
    ]);
  });

  it("renders the history fold's timeline and marks unwritten chapters honestly", () => {
    const doc = parse(renderDemo());
    const folds = Array.from(doc.querySelectorAll("#more details.fold"));
    const history = folds[folds.length - 1]!;
    expect(history.querySelector("ol.timeline")).not.toBeNull();
    const journeys = folds[0]!;
    expect(journeys.textContent).toContain("Not yet written");
  });
});

// ---------------------------------------------------------------------------
// Provenance markers
// ---------------------------------------------------------------------------

describe("provenance markers", () => {
  it("marks derived evidence anchors with a ✓ glyph plus a title explanation", () => {
    const doc = parse(renderDemo());
    const marks = doc.querySelectorAll("ul.evidence .prov");
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of Array.from(marks)) {
      expect(mark.textContent).toBe("✓");
      expect(mark.getAttribute("title")).toBeTruthy();
    }
  });

  it("shows no ◇ marker when everything is derived (honest provenance)", () => {
    expect(renderDemo()).not.toContain("◇");
  });

  it("marks narrated units with ◇ in the overview timeline too", () => {
    const change = demoChange();
    change.changeUnits[0]!.provenance = "inferred";
    const doc = parse(renderChangeBook(demoBook(change), change));
    expect(doc.querySelector("#overview ol.timeline")!.textContent).toContain("◇");
  });
});

// ---------------------------------------------------------------------------
// Diagram insertion point
// ---------------------------------------------------------------------------

describe("diagram insertion point", () => {
  it("invokes the renderDiagram callback for the architecture view", () => {
    const requests: DiagramRequest[] = [];
    const html = renderDemo({
      renderDiagram: (req) => {
        requests.push(req);
        return `<svg role="img" aria-label="diagram" viewBox="0 0 10 10"></svg>`;
      }
    });
    const context = requests.filter((r) => r.kind === "context");
    expect(context.length).toBe(1);
    expect(context[0]!.entities.length).toBe(3);
    expect(html).toContain('aria-label="diagram"');
  });

  it("renders a placeholder figure when no diagram renderer is supplied", () => {
    const doc = parse(renderDemo());
    const placeholders = doc.querySelectorAll("figure.diagram-placeholder");
    expect(placeholders.length).toBeGreaterThan(0);
    expect(doc.querySelectorAll("svg").length).toBe(0);
  });

  it("renders a placeholder when the callback declines with null", () => {
    const doc = parse(renderDemo({ renderDiagram: () => null }));
    expect(doc.querySelectorAll("figure.diagram-placeholder").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Hostile input
// ---------------------------------------------------------------------------

describe("hostile repo content", () => {
  function renderHostile(): string {
    const change = hostileChange();
    return renderChangeBook(demoBook(change), change);
  }

  it("keeps zero script tags with hostile labels everywhere", () => {
    const doc = parse(renderHostile());
    expect(doc.querySelectorAll("script").length).toBe(0);
    expect(doc.querySelectorAll("img").length).toBe(0);
  });

  it("never emits the raw hostile strings", () => {
    const html = renderHostile();
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("</section><script>");
  });

  it("shows the hostile labels as escaped text", () => {
    const doc = parse(renderHostile());
    const text = doc.body.textContent;
    expect(text).toContain("<img src=x onerror=alert(1)>.ts");
    expect(text).toContain('</section><script>alert(2)</script>');
  });

  it("emits no javascript: hrefs", () => {
    const doc = parse(renderHostile());
    for (const a of Array.from(doc.querySelectorAll("[href]"))) {
      expect(a.getAttribute("href")!.toLowerCase().startsWith("javascript:")).toBe(false);
    }
  });

  it("keeps the light-theme-only mandate: no prefers-color-scheme dark block", () => {
    expect(renderHostile()).not.toContain("prefers-color-scheme");
  });
});
