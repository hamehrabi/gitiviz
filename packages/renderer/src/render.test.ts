import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import type { BookManifest, ChangeManifest } from "@gitiviz/schema";
import { CHAPTER_IDS, validateBookManifest, validateChangeManifest } from "@gitiviz/schema";
import {
  collectMermaidSources,
  renderChangeBook,
  type DiagramRequest
} from "./render.js";

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

const TAB_HREFS = [
  "#home",
  "#overview",
  "#architecture",
  "#how-it-works",
  "#issues",
  "#more"
];

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

  it("ships exactly one <style> concatenating shell + module CSS", () => {
    const doc = parse(renderDemo());
    const styles = doc.querySelectorAll("style");
    expect(styles.length).toBe(1);
    const css = styles[0]!.textContent;
    // One marker rule from each contributor, in shell→sb→cd→cp→iv order.
    const order = [".layout{", ".sb-nav{", ".cd-grid{", ".cp-page{", ".iv-card{"].map(
      (m) => css.indexOf(m)
    );
    for (const index of order) expect(index).toBeGreaterThanOrEqual(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("stays byte-deterministic", () => {
    expect(renderDemo()).toBe(renderDemo());
  });
});

// ---------------------------------------------------------------------------
// Sidebar: wordmark + tab nav
// ---------------------------------------------------------------------------

describe("sidebar", () => {
  it("puts the repo wordmark at the top of the sidebar nav", () => {
    const doc = parse(renderDemo());
    const sidebar = doc.querySelector("nav.sb-nav");
    expect(sidebar).not.toBeNull();
    const wordmark = sidebar!.querySelector(".sb-wordmark");
    expect(wordmark).not.toBeNull();
    expect(wordmark!.textContent).toBe("demo-app");
    // Wordmark precedes the tab list.
    expect(sidebar!.firstElementChild).toBe(wordmark);
  });

  it("prefers the repoName option for the wordmark and document title", () => {
    const change = demoChange();
    const doc = parse(
      renderChangeBook(demoBook(change), change, { repoName: "Demo App" })
    );
    expect(doc.querySelector(".sb-wordmark")!.textContent).toBe("Demo App");
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
    expect(css).toMatch(/\.sb-nav\{[^}]*position:sticky/);
    expect(css).toContain("@media (max-width:736px)");
    const collapsed = css.slice(css.indexOf("@media (max-width:736px)"));
    expect(collapsed).toMatch(/\.sb-tabs\{[^}]*overflow-x:auto/);
  });
});

describe("tab navigation", () => {
  it("renders the six view tabs, in order, as plain anchors", () => {
    const doc = parse(renderDemo());
    const nav = doc.querySelector("nav.sb-nav");
    expect(nav).not.toBeNull();
    expect(nav!.getAttribute("aria-label")).toBeTruthy();
    const tabs = Array.from(nav!.querySelectorAll("a.sb-tab"));
    expect(tabs.map((a) => a.getAttribute("href"))).toEqual(TAB_HREFS);
    expect(tabs.map((a) => a.textContent)).toEqual([
      "Home",
      "Overview",
      "Architecture",
      "How it works",
      "Issues",
      "More"
    ]);
  });

  it("points every tab at a real section id", () => {
    const doc = parse(renderDemo());
    for (const a of Array.from(doc.querySelectorAll("nav.sb-nav a.sb-tab"))) {
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

  it("marks the Home tab active by default (class + aria-current)", () => {
    const doc = parse(renderDemo());
    const activeItems = doc.querySelectorAll(".sb-item-active");
    expect(activeItems.length).toBe(1);
    const anchor = activeItems[0]!.querySelector("a.sb-tab")!;
    expect(anchor.getAttribute("href")).toBe("#home");
    expect(anchor.getAttribute("aria-current")).toBe("page");
  });

  it("moves the active-tab highlight with :has when another view is targeted", () => {
    const css = styleOf(renderDemo());
    // Progressive enhancement: browsers without :has simply keep Home lit.
    expect(css).toContain(
      "body:has(#overview:target,#architecture:target,#how-it-works:target," +
        "#issues:target,#more:target) .sb-item-active .sb-tab"
    );
    for (const id of ["overview", "architecture", "how-it-works", "issues", "more"]) {
      expect(css).toContain(`body:has(#${id}:target) .sb-tabs a[href="#${id}"]`);
    }
  });
});

// ---------------------------------------------------------------------------
// Home: commit cards grid
// ---------------------------------------------------------------------------

describe("home cards grid", () => {
  it("renders one card per meaningful change unit; grouped commits get none", () => {
    const doc = parse(renderDemo());
    const cards = doc.querySelectorAll("#home .cd-grid .cd-card");
    expect(cards.length).toBe(2);
    expect(doc.querySelector("#home")!.textContent).not.toContain("fixup!");
  });

  it("summarizes the comparison in the home view head", () => {
    const doc = parse(renderDemo());
    const sub = doc.querySelector("#home .view-sub")!;
    expect(sub.textContent).toContain("2 meaningful changes");
    expect(sub.textContent).toContain("aaaaaaaaaa");
    expect(sub.textContent).toContain("bbbbbbbbbb");
    expect(doc.querySelector("#home")!.textContent).not.toContain("a".repeat(40));
  });

  it("shows the narrated human title, falling back to the technical title", () => {
    const doc = parse(renderDemo());
    const titles = Array.from(doc.querySelectorAll("#home .cd-card .cd-title")).map(
      (t) => t.textContent.trim()
    );
    expect(titles).toEqual([
      "Guests can now check out",
      "refactor: rename order helpers"
    ]);
  });

  it("shows a one-line summary when narrated, and the short sha", () => {
    const doc = parse(renderDemo());
    const cards = Array.from(doc.querySelectorAll("#home .cd-card"));
    expect(cards[0]!.querySelector(".cd-summary")!.textContent).toBe(
      "Adds a POST /orders route with validation."
    );
    expect(cards[1]!.querySelector(".cd-summary")).toBeNull();
    expect(cards[0]!.querySelector("code.cd-sha")!.textContent).toBe("ccccccc");
    expect(cards[1]!.querySelector("code.cd-sha")!.textContent).toBe("ddddddd");
  });

  it("derives the type tag from the conventional-commit prefix", () => {
    const doc = parse(renderDemo());
    const cards = Array.from(doc.querySelectorAll("#home .cd-card"));
    expect(cards[0]!.querySelector(".cd-tag")!.textContent).toBe("Feature");
    expect(cards[0]!.getAttribute("class")).toContain("cd-type-feature");
    // refactor: falls into the housekeeping bucket.
    expect(cards[1]!.querySelector(".cd-tag")!.textContent).toBe("Housekeeping");
    expect(cards[1]!.getAttribute("class")).toContain("cd-type-housekeeping");
  });

  it("shows affected-chapter chips derived from what the unit touches", () => {
    const doc = parse(renderDemo());
    const cards = Array.from(doc.querySelectorAll("#home .cd-card"));
    const chipTexts = cards.map((card) =>
      Array.from(card.querySelectorAll(".cd-chapter")).map((c) => c.textContent)
    );
    // unit-1 touches entities (systems), a relationship (flows), a route
    // (contracts); unit-2 touches only a module entity.
    expect(chipTexts).toEqual([["Systems", "Flows", "Contracts"], ["Systems"]]);
  });

  it("marks narrated cards with the ◇ provenance glyph", () => {
    const change = demoChange();
    change.changeUnits[0]!.provenance = "inferred";
    const doc = parse(renderChangeBook(demoBook(change), change));
    const card = doc.querySelector("#home .cd-card")!;
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
    expect(home.querySelectorAll(".cd-card").length).toBe(0);
    expect(home.querySelectorAll('input[name="cd-filter"]').length).toBe(0);
    expect(home.textContent).toContain("No meaningful changes");
  });
});

// ---------------------------------------------------------------------------
// Home: CSS-only filter chips
// ---------------------------------------------------------------------------

describe("filter chips (scriptless)", () => {
  it('offers "All" plus exactly the commit types present', () => {
    const doc = parse(renderDemo());
    const labels = Array.from(doc.querySelectorAll("#home .cd-filters label")).map(
      (l) => l.textContent
    );
    expect(labels).toEqual(["All", "Feature", "Housekeeping"]);
  });

  it("uses radio inputs preceding the grid so sibling selectors can filter", () => {
    const doc = parse(renderDemo());
    const home = doc.querySelector("#home")!;
    const children = Array.from(home.children);
    const radios = children.filter((el) => el.tagName.toLowerCase() === "input");
    expect(radios.map((r) => r.getAttribute("id"))).toEqual([
      "cd-filter-all",
      "cd-filter-feature",
      "cd-filter-housekeeping"
    ]);
    for (const radio of radios) {
      expect(radio.getAttribute("type")).toBe("radio");
      expect(radio.getAttribute("name")).toBe("cd-filter");
    }
    expect(
      radios.filter((r) => r.hasAttribute("checked")).map((r) => r.getAttribute("id"))
    ).toEqual(["cd-filter-all"]);
    // Document order: radios, then chips, then the grid — all siblings under
    // the same parent. The `~` selectors in cardsCss depend on it.
    const kinds = children.map((el) =>
      el.tagName.toLowerCase() === "input"
        ? "input"
        : (el.getAttribute("class") ?? "").split(" ")[0]!
    );
    expect(kinds.lastIndexOf("input")).toBeLessThan(kinds.indexOf("cd-filters"));
    expect(kinds.indexOf("cd-filters")).toBeLessThan(kinds.indexOf("cd-grid"));
  });

  it("binds every chip label to a real filter radio", () => {
    const doc = parse(renderDemo());
    for (const label of Array.from(doc.querySelectorAll("#home .cd-filters label"))) {
      const target = doc.getElementById(label.getAttribute("for")!);
      expect(target).not.toBeNull();
      expect(target!.getAttribute("name")).toBe("cd-filter");
    }
  });

  it("hides non-matching cards via sibling selectors when a type is checked", () => {
    const css = styleOf(renderDemo());
    for (const type of ["feature", "housekeeping"]) {
      expect(css).toContain(
        `#cd-filter-${type}:checked~.cd-grid .cd-card:not(.cd-type-${type}){display:none}`
      );
    }
    // No hide rule for All — everything stays visible.
    expect(css).not.toContain("#cd-filter-all:checked~.cd-grid");
  });

  it("gives the checked chip an active state and a focus ring", () => {
    const css = styleOf(renderDemo());
    for (const id of ["cd-filter-all", "cd-filter-feature", "cd-filter-housekeeping"]) {
      expect(css).toContain(`#${id}:checked~.cd-filters .cd-chip[for="${id}"]`);
      expect(css).toContain(
        `#${id}:focus-visible~.cd-filters .cd-chip[for="${id}"]{outline:`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Commit pages (:target navigation)
// ---------------------------------------------------------------------------

describe("commit pages (:target navigation)", () => {
  it("renders every card as an anchor onto that commit's own page", () => {
    const doc = parse(renderDemo());
    const cards = Array.from(doc.querySelectorAll("#home .cd-grid a.cd-card"));
    expect(cards.length).toBe(2);
    expect(cards.map((c) => c.getAttribute("href"))).toEqual(["#u0", "#u1"]);
    for (const card of cards) {
      const target = doc.getElementById(card.getAttribute("href")!.slice(1));
      expect(target).not.toBeNull();
      expect(target!.getAttribute("class")).toBe("cp-page");
      // Clickability affordance: the arrow glyph, hidden from readers.
      const arrow = card.querySelector(".cd-arrow");
      expect(arrow).not.toBeNull();
      expect(arrow!.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("renders one commit page per meaningful unit; grouped commits get none", () => {
    const doc = parse(renderDemo());
    expect(doc.querySelectorAll("main > section.cp-page").length).toBe(2);
    const headings = Array.from(
      doc.querySelectorAll("section.cp-page h2.cp-title")
    ).map((h) => h.textContent);
    expect(headings).toEqual([
      "Guests can now check out",
      "refactor: rename order helpers"
    ]);
  });

  it("reveals exactly one commit page via :target and hides home meanwhile", () => {
    const css = styleOf(renderDemo());
    // Same generic rules as the tabs: hidden by default, shown on :target,
    // home (the last section) hidden by the sibling rule.
    expect(css).toContain("main>section{display:none");
    expect(css).toContain("main>section:target{display:block}");
    expect(css).toContain("main>section:target~#home{display:none}");
    const doc = parse(renderDemo());
    const sections = Array.from(doc.querySelectorAll("main > section"));
    expect(sections[sections.length - 1]!.getAttribute("id")).toBe("home");
    // Commit pages precede home so the sibling rule reaches it.
    for (const page of Array.from(doc.querySelectorAll("section.cp-page"))) {
      expect(sections.indexOf(page as (typeof sections)[number])).toBeLessThan(
        sections.length - 1
      );
    }
  });

  it("orders the page: meta, title, purpose, before/after, diagram, unchanged, footer, evidence", () => {
    const doc = parse(renderDemo());
    const page = doc.getElementById("u0")!;
    const kinds = Array.from(page.children).map(
      (el) => `${el.tagName.toLowerCase()}.${(el.getAttribute("class") ?? "").split(" ")[0]}`
    );
    expect(kinds).toEqual([
      "p.cp-meta",
      "h2.cp-title",
      "p.cp-purpose",
      "dl.cp-beforeafter",
      "figure.cp-diagram",
      "details.cp-unchanged",
      "footer.cp-footer",
      "details.cp-evidence"
    ]);
  });

  it("keeps the cognitive-load budget: at most 8 elements before folds", () => {
    const doc = parse(renderDemo());
    for (const page of Array.from(doc.querySelectorAll("section.cp-page"))) {
      expect(page.children.length).toBeLessThanOrEqual(8);
    }
  });

  it("shows before and after as short labeled rows", () => {
    const doc = parse(renderDemo());
    const rows = Array.from(doc.querySelectorAll("#u0 .cp-beforeafter .cp-row"));
    const labeled = rows.map((row) => [
      row.querySelector("dt")!.textContent,
      row.querySelector("dd")!.textContent
    ]);
    expect(labeled).toEqual([
      ["Before", "Only registered users could order."],
      ["After", "Guests can place orders too."]
    ]);
  });

  it("puts the one-sentence purpose (user impact first) right under the title", () => {
    const doc = parse(renderDemo());
    const purpose = doc.querySelector("#u0 .cp-purpose")!;
    expect(purpose.textContent).toBe("Guests no longer need an account.");
  });

  it("collapses what stayed unchanged to a one-line count", () => {
    const doc = parse(renderDemo());
    const unchanged = doc.querySelector("#u0 details.cp-unchanged")!;
    expect(unchanged.hasAttribute("open")).toBe(false);
    expect(unchanged.querySelector("summary")!.textContent).toBe(
      "Unchanged: 1 component"
    );
  });

  it("offers a prominent back link that clears the fragment (browser Back works too)", () => {
    const doc = parse(renderDemo());
    const backs = Array.from(doc.querySelectorAll("section.cp-page a.cp-back-link"));
    expect(backs.length).toBe(2);
    for (const back of backs) {
      // "#" un-targets the page, so Home — the default view — returns.
      expect(back.getAttribute("href")).toBe("#");
      expect(back.textContent).toBe("← All changes");
    }
  });

  it("advertises /gitiviz:discuss with each page's own sha in the footer panel", () => {
    const doc = parse(renderDemo());
    const cmds = Array.from(
      doc.querySelectorAll("section.cp-page .cp-footer code.cp-discuss-cmd")
    ).map((code) => code.textContent);
    expect(cmds).toEqual(["/gitiviz:discuss ccccccc", "/gitiviz:discuss ddddddd"]);
    // The panel sits in the same footer as the back link, before the
    // evidence fold — the ≤8-child budget test above still covers it.
    const footer = doc.querySelector("#u0 footer.cp-footer")!;
    expect(footer.querySelector("a.cp-back-link")).not.toBeNull();
    expect(footer.querySelector(".cp-discuss-title")!.textContent).toBe(
      "Discuss & ticket"
    );
  });

  it("omits the discuss panel for a unit with no commit sha", () => {
    const change = demoChange();
    delete change.changeUnits[1]!.commits;
    const doc = parse(renderChangeBook(demoBook(change), change));
    expect(doc.querySelector("#u0 .cp-discuss")).not.toBeNull();
    expect(doc.querySelector("#u1 .cp-discuss")).toBeNull();
    expect(doc.querySelector("#u1 a.cp-back-link")).not.toBeNull();
  });

  it("keeps technical evidence collapsed at the very bottom", () => {
    const doc = parse(renderDemo());
    const page = doc.getElementById("u0")!;
    const last = page.lastElementChild!;
    expect(last.tagName.toLowerCase()).toBe("details");
    expect(last.hasAttribute("open")).toBe(false);
    expect(last.querySelector("summary")!.textContent).toBe("Technical evidence");
    expect(last.textContent).toContain("feat: add guest checkout route");
    expect(last.textContent).toContain("src/routes/orders.ts");
  });

  it("marks narrated page titles with the ◇ provenance glyph", () => {
    const change = demoChange();
    change.changeUnits[0]!.provenance = "inferred";
    const doc = parse(renderChangeBook(demoBook(change), change));
    const mark = doc.querySelector("#u0 h2.cp-title .prov");
    expect(mark).not.toBeNull();
    expect(mark!.textContent).toBe("◇");
    expect(mark!.getAttribute("title")).toContain("AI interpretation");
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

  function narratedOverviewChange(): ChangeManifest {
    const change = demoChange();
    change.projectNarration = {
      summary: "A demo shop that now sells to guests.",
      provenance: "inferred",
      confidence: 0.9
    };
    change.chapterNarrations = {
      purpose: {
        summary: "Why the shop exists.",
        keyPoints: ["Sell things fast.", "Let anyone check out."],
        provenance: "inferred",
        confidence: 0.9
      }
    };
    return change;
  }

  it("narrated overview fixture stays schema-valid", () => {
    expect(validateChangeManifest(narratedOverviewChange()).ok).toBe(true);
  });

  it("leads with the ◇ project narration above the derived count line", () => {
    const change = narratedOverviewChange();
    const doc = parse(renderChangeBook(demoBook(change), change));
    const overview = doc.querySelector("#overview")!;
    const lead = overview.querySelector("p.lead");
    expect(lead).not.toBeNull();
    expect(lead!.textContent).toContain("A demo shop that now sells to guests.");
    const mark = lead!.querySelector(".prov");
    expect(mark).not.toBeNull();
    expect(mark!.textContent).toBe("◇");
    const html = overview.innerHTML;
    expect(html.indexOf('class="lead"')).toBeLessThan(
      html.indexOf("meaningful change")
    );
  });

  it("renders Why-it-exists key points, ◇ each, after the count line", () => {
    const change = narratedOverviewChange();
    const doc = parse(renderChangeBook(demoBook(change), change));
    const overview = doc.querySelector("#overview")!;
    const heading = Array.from(overview.querySelectorAll("h3")).find(
      (h) => h.textContent === "Why it exists"
    );
    expect(heading).toBeDefined();
    const points = Array.from(overview.querySelectorAll("ul.keypoints li"));
    expect(points.map((p) => p.textContent.replace("◇", "").trim())).toEqual([
      "Sell things fast.",
      "Let anyone check out."
    ]);
    for (const point of points) {
      expect(point.querySelector(".prov")!.textContent).toBe("◇");
    }
    const html = overview.innerHTML;
    expect(html.indexOf("meaningful change")).toBeLessThan(
      html.indexOf("Why it exists")
    );
  });

  it("renders neither narration slot when un-narrated (honest absence)", () => {
    const doc = parse(renderDemo());
    const overview = doc.querySelector("#overview")!;
    expect(overview.querySelector("p.lead")).toBeNull();
    expect(overview.querySelector("ul.keypoints")).toBeNull();
    expect(overview.textContent).not.toContain("Why it exists");
  });

  it("escapes hostile narration text in the lead and key points", () => {
    const change = narratedOverviewChange();
    change.projectNarration!.summary = '<script>alert("lead")</script>';
    change.chapterNarrations!.purpose!.keyPoints = ['"><img src=x onerror=alert(1)>'];
    const html = renderChangeBook(demoBook(change), change);
    expect(html).not.toContain('<script>alert("lead")');
    expect(html).not.toContain("<img src=x");
    const doc = parse(html);
    expect(doc.querySelectorAll("script").length).toBe(0);
    expect(doc.querySelector("#overview p.lead")!.textContent).toContain(
      '<script>alert("lead")</script>'
    );
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
    // The relationship list keeps its heading here (howItWorksView folds
    // the same list under "Derived connections" instead).
    const headings = Array.from(section.querySelectorAll("h3")).map(
      (h) => h.textContent
    );
    expect(headings).toContain("Connections");
    expect(section.querySelector("ul.relationships")).not.toBeNull();
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
  function narratedFlowsChange(): ChangeManifest {
    const change = demoChange();
    change.chapterNarrations = {
      flows: {
        summary: "Install the CLI once, then compare any two revisions.",
        keyPoints: [
          "Install the plugin.",
          "Run the compare command.",
          "Open the book in a browser."
        ],
        provenance: "inferred",
        confidence: 0.9
      }
    };
    return change;
  }

  it("narrated flows fixture stays schema-valid", () => {
    expect(validateChangeManifest(narratedFlowsChange()).ok).toBe(true);
  });

  it("asks the install-and-usage question", () => {
    const doc = parse(renderDemo());
    const section = doc.querySelector("#how-it-works")!;
    expect(section.querySelector("h2")!.textContent).toBe("How it works");
    expect(section.querySelector(".view-sub")!.textContent).toBe(
      "How do I install and use it?"
    );
  });

  it("renders the narrated guide as a ◇ lead plus numbered steps", () => {
    const change = narratedFlowsChange();
    const doc = parse(renderChangeBook(demoBook(change), change));
    const section = doc.querySelector("#how-it-works")!;
    const lead = section.querySelector("p.lead");
    expect(lead).not.toBeNull();
    expect(lead!.textContent).toContain(
      "Install the CLI once, then compare any two revisions."
    );
    expect(lead!.querySelector(".prov")!.textContent).toBe("◇");
    const steps = Array.from(
      section.querySelectorAll("ol.guide-steps li")
    ).map((li) => li.textContent);
    expect(steps).toEqual([
      "Install the plugin.",
      "Run the compare command.",
      "Open the book in a browser."
    ]);
  });

  it("moves the relationship dump inside a closed Derived-connections fold", () => {
    const change = narratedFlowsChange();
    const doc = parse(renderChangeBook(demoBook(change), change));
    const section = doc.querySelector("#how-it-works")!;
    const fold = section.querySelector("details.connections");
    expect(fold).not.toBeNull();
    expect(fold!.hasAttribute("open")).toBe(false);
    expect(fold!.querySelector("summary")!.textContent).toBe("Derived connections");
    expect(fold!.querySelector("ul.relationships")!.textContent).toContain(
      "Create order endpoint —creates order via→ Order service"
    );
    // The dump lives ONLY inside the fold — never in the default view.
    expect(section.querySelectorAll("ul.relationships").length).toBe(1);
    expect(section.querySelectorAll("h3").length).toBe(0);
  });

  it("points at /gitiviz:init when un-narrated but relationships exist", () => {
    const doc = parse(renderDemo());
    const section = doc.querySelector("#how-it-works")!;
    expect(section.textContent).toContain(
      "No usage guide narrated yet — run /gitiviz:init."
    );
    expect(section.querySelector("p.lead")).toBeNull();
    expect(section.querySelector("ol.guide-steps")).toBeNull();
    expect(section.querySelector("details.connections")).not.toBeNull();
  });

  it("says Not yet written with neither narration nor relationships", () => {
    const change = demoChange();
    change.relationships = [];
    const doc = parse(renderChangeBook(demoBook(change), change));
    const section = doc.querySelector("#how-it-works")!;
    expect(section.textContent).toContain("Not yet written.");
    expect(section.querySelector("details.connections")).toBeNull();
  });

  it("escapes hostile narrated guide text", () => {
    const change = narratedFlowsChange();
    change.chapterNarrations!.flows!.summary = '<script>alert("guide")</script>';
    change.chapterNarrations!.flows!.keyPoints = ['"><img src=x onerror=alert(1)>'];
    const html = renderChangeBook(demoBook(change), change);
    expect(html).not.toContain('<script>alert("guide")');
    expect(html).not.toContain("<img src=x");
    const doc = parse(html);
    expect(doc.querySelectorAll("script").length).toBe(0);
    expect(
      doc.querySelector("#how-it-works ol.guide-steps li")!.textContent
    ).toBe('"><img src=x onerror=alert(1)>');
  });
});

// ---------------------------------------------------------------------------
// Issues view (RenderOptions.issues → iv- cards)
// ---------------------------------------------------------------------------

describe("issues view", () => {
  const demoIssues = [
    {
      number: 7,
      title: "Guest checkout drops the cart",
      state: "OPEN",
      url: "https://github.com/acme/demo/issues/7",
      createdAt: "2026-07-30T09:15:00Z"
    }
  ];

  it("renders the Issues section with the honest empty state by default", () => {
    const doc = parse(renderDemo());
    const section = doc.querySelector("#issues")!;
    expect(section).not.toBeNull();
    expect(section.querySelector("h2")!.textContent).toBe("Issues");
    expect(section.querySelector(".view-sub")!.textContent).toBe(
      "What has been discussed and ticketed?"
    );
    expect(section.textContent).toContain(
      "No tickets yet — create one from any commit page."
    );
    expect(section.querySelectorAll(".iv-card").length).toBe(0);
  });

  it("renders issue cards from RenderOptions.issues (linkless without an origin)", () => {
    const doc = parse(renderDemo({ issues: demoIssues }));
    const section = doc.querySelector("#issues")!;
    const card = section.querySelector(".iv-card")!;
    expect(card).not.toBeNull();
    expect(card.tagName.toLowerCase()).toBe("div");
    expect(card.querySelector(".iv-number")!.textContent).toBe("#7");
    expect(card.querySelector(".iv-state")!.textContent).toBe("open");
    expect(card.querySelector(".iv-date")!.textContent).toBe("2026-07-30");
    expect(card.querySelector(".iv-title")!.textContent).toBe(
      "Guest checkout drops the cart"
    );
    expect(section.textContent).not.toContain("No tickets yet");
  });

  it("links issue cards only through the links.origin contract field", () => {
    const doc = parse(
      renderDemo({
        issues: demoIssues,
        links: { origin: "https://github.com/acme/demo" }
      })
    );
    const link = doc.querySelector("#issues a.iv-card")!;
    expect(link).not.toBeNull();
    expect(link.getAttribute("href")).toBe("https://github.com/acme/demo/issues/7");
    expect(link.getAttribute("rel")).toBe("noopener");
  });

  it("keeps hostile issues inert end to end", () => {
    const html = renderDemo({
      issues: [
        {
          number: 1,
          title: "<img src=x onerror=alert(1)>",
          state: 'open"><script>alert(2)</script>',
          url: "javascript:alert(3)",
          createdAt: "2026-01-01T00:00:00Z"
        }
      ],
      links: { origin: "https://github.com/acme/demo" }
    });
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x");
    const doc = parse(html);
    expect(doc.querySelectorAll("script").length).toBe(0);
    expect(doc.querySelectorAll("#issues a").length).toBe(0);
    for (const el of Array.from(doc.querySelectorAll("[href]"))) {
      expect(el.getAttribute("href")!.toLowerCase().startsWith("javascript:")).toBe(
        false
      );
    }
  });

  it("stays byte-deterministic with issues configured", () => {
    const render = () => renderDemo({ issues: demoIssues });
    expect(render()).toBe(render());
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
    const marks = doc.querySelectorAll("ul.evidence .prov, .cp-ev-list .prov");
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
  it("invokes the renderDiagram callback for the full evidence graphs, folded away", () => {
    const requests: DiagramRequest[] = [];
    const html = renderDemo({
      renderDiagram: (req) => {
        requests.push(req);
        return `<svg role="img" aria-label="full-graph" viewBox="0 0 10 10"></svg>`;
      }
    });
    const context = requests.filter((r) => r.kind === "context");
    expect(context.length).toBe(1);
    expect(context[0]!.entities.length).toBe(3);
    // One before→after projection per commit page, scoped to the unit.
    const changes = requests.filter((r) => r.kind === "change");
    expect(changes.length).toBe(2);
    const changeReq = changes.find((r) => r.changeUnit?.id === "unit-1")!;
    expect(changeReq.entities.map((e) => e.id).sort()).toEqual(["ent-route", "ent-service"]);
    expect(changeReq.relationships.map((r) => r.id)).toEqual(["rel-1"]);
    expect(html).toContain('aria-label="full-graph"');
    // Full entity graphs live ONLY inside collapsed details, never in a
    // default view (user mandate: no file/module grids outside evidence).
    const doc = parse(html);
    const fullGraphs = Array.from(doc.querySelectorAll('svg[aria-label="full-graph"]'));
    expect(fullGraphs.length).toBe(3);
    for (const svg of fullGraphs) {
      const details = svg.closest("details");
      expect(details).not.toBeNull();
      expect(details!.hasAttribute("open")).toBe(false);
    }
  });

  it("always renders the story diagram as the hero — even with no callback", () => {
    const doc = parse(renderDemo());
    // Architecture hero: the overview story rolled up by the built-in engine.
    expect(doc.querySelectorAll("#architecture figure.diagram svg").length).toBe(1);
    // One story hero per commit page.
    expect(doc.querySelectorAll("figure.cp-diagram svg").length).toBe(2);
    // The honest note explains that Mermaid was unavailable at build time.
    expect(doc.body.textContent).toContain("built-in diagram engine");
  });

  it("omits evidence graphs quietly when the callback declines with null", () => {
    const doc = parse(renderDemo({ renderDiagram: () => null }));
    // Heroes still render through the built-in story engine.
    expect(doc.querySelectorAll("figure.cp-diagram svg").length).toBe(2);
    // No dangling placeholders inside the evidence folds.
    expect(doc.querySelectorAll("details figure.diagram-placeholder").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Mermaid concept diagrams (visual bar: docs/visual-reference.mmd)
// ---------------------------------------------------------------------------

describe("mermaid concept diagrams", () => {
  function narratedChange(): ChangeManifest {
    const change = demoChange();
    change.architectureDiagram = {
      clusters: [{ id: "shop", title: "Shop & Checkout", tone: "blue" }],
      nodes: [
        {
          id: "orders",
          cluster: "shop",
          humanLabel: "Order intake",
          role: "order endpoints",
          file: "src/routes/orders.ts"
        }
      ],
      edges: [],
      provenance: "inferred",
      confidence: 0.9
    };
    change.changeUnits[0]!.storyDiagram = {
      nodes: [
        { id: "checkout", humanLabel: "Guest checkout", role: "new order path" },
        { id: "orders", humanLabel: "Order intake", role: "order endpoints" }
      ],
      edges: [{ from: "checkout", to: "orders", verb: "submits orders to" }],
      provenance: "inferred",
      confidence: 0.9
    };
    return change;
  }

  it("narrated fixtures stay schema-valid", () => {
    expect(validateChangeManifest(narratedChange()).ok).toBe(true);
  });

  it("collects one deterministic mermaid source per diagram slot", () => {
    const change = narratedChange();
    const sources = collectMermaidSources(demoBook(change), change);
    const ids = sources.map((s) => s.id);
    expect(ids).toEqual(["architecture", "u0", "u1"]);
    for (const source of sources) {
      expect(source.text.startsWith("flowchart TD")).toBe(true);
    }
    // The narrated architecture diagram wins over the story projection.
    expect(sources[0]!.text).toContain("Shop #amp; Checkout");
    // The narrated unit story wins for u0; u1 falls back to the projection.
    expect(sources[1]!.text).toContain('|"submits orders to"|');
    expect(sources[2]!.text).toContain("Other changes");
  });

  it("skips the architecture slot when the systems chapter is not written", () => {
    const change = narratedChange();
    const book = demoBook(change);
    book.chapters = book.chapters.map((c) =>
      c.id === "systems" ? { ...c, status: "not-written" as const } : c
    );
    const ids = collectMermaidSources(book, change).map((s) => s.id);
    expect(ids).toEqual(["u0", "u1"]);
  });

  it("embeds prerendered SVGs big and first, with no fallback note", () => {
    const change = narratedChange();
    const book = demoBook(change);
    const svgs = new Map(
      collectMermaidSources(book, change).map(({ id, text }) => [
        id,
        { text, svg: `<svg role="img" aria-label="mmd-${id}" viewBox="0 0 10 10"></svg>` }
      ])
    );
    const doc = parse(renderChangeBook(book, change, { mermaid: { svgs } }));
    const arch = doc.querySelector("#architecture")!;
    expect(arch.querySelector('svg[aria-label="mmd-architecture"]')).not.toBeNull();
    // Big and first: the hero figure precedes the entity list and evidence.
    const archHtml = arch.innerHTML;
    expect(archHtml.indexOf("mmd-architecture")).toBeLessThan(archHtml.indexOf("<details"));
    expect(doc.querySelector('#u0 figure.cp-diagram svg[aria-label="mmd-u0"]')).not.toBeNull();
    expect(doc.querySelector('#u1 figure.cp-diagram svg[aria-label="mmd-u1"]')).not.toBeNull();
    expect(doc.body.textContent).not.toContain("built-in diagram engine");
  });

  it("commit pages put plain English before any diagram", () => {
    const change = narratedChange();
    const book = demoBook(change);
    const doc = parse(renderChangeBook(book, change, {}));
    const page = doc.querySelector("#u0")!;
    const html = page.innerHTML;
    expect(html.indexOf("cp-title")).toBeLessThan(html.indexOf("cp-diagram"));
    expect(html.indexOf("cp-beforeafter")).toBeLessThan(html.indexOf("cp-diagram"));
  });

  it("emits no Diagram source folds — mermaid text never ships in the page", () => {
    const change = narratedChange();
    const book = demoBook(change);
    const html = renderChangeBook(book, change, {});
    expect(html).not.toContain("Diagram source");
    expect(html).not.toContain("diagram-source");
    expect(html).not.toContain("cp-source");
    const doc = parse(html);
    expect(doc.querySelector("figure.diagram details")).toBeNull();
    expect(doc.querySelector("figure.cp-diagram details")).toBeNull();
  });

  it("ignores a prerendered SVG whose source text no longer matches", () => {
    const change = narratedChange();
    const book = demoBook(change);
    const svgs = new Map([
      [
        "architecture",
        { text: "flowchart TD\nstale", svg: `<svg role="img" aria-label="stale"></svg>` }
      ]
    ]);
    const doc = parse(renderChangeBook(book, change, { mermaid: { svgs } }));
    expect(doc.querySelector('svg[aria-label="stale"]')).toBeNull();
    // Falls back honestly instead.
    expect(doc.querySelector("#architecture")!.textContent).toContain("built-in diagram engine");
  });

  it("threads the click-through link base into the collected sources", () => {
    const change = narratedChange();
    const sources = collectMermaidSources(demoBook(change), change, {
      linkBase: "https://github.com/acme/demo/blob/abc123"
    });
    expect(sources[0]!.text).toContain(
      'click n0 "https://github.com/acme/demo/blob/abc123/src/routes/orders.ts" _blank'
    );
  });

  it("stays byte-deterministic with mermaid options", () => {
    const change = narratedChange();
    const book = demoBook(change);
    const svgs = new Map(
      collectMermaidSources(book, change).map(({ id, text }) => [
        id,
        { text, svg: `<svg role="img" aria-label="mmd-${id}"></svg>` }
      ])
    );
    const a = renderChangeBook(book, change, { mermaid: { svgs } });
    const b = renderChangeBook(book, change, { mermaid: { svgs } });
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Sources links (RenderOptions.links → evidence fold anchors)
// ---------------------------------------------------------------------------

describe("sources links", () => {
  const LINK_BASE = "https://github.com/acme/demo/blob/" + "b".repeat(40);

  it("threads links.linkBase into origin-validated Sources anchors", () => {
    const change = demoChange();
    const doc = parse(
      renderChangeBook(demoBook(change), change, {
        links: { linkBase: LINK_BASE, origin: "https://github.com" }
      })
    );
    const link = doc.querySelector('#u0 .cp-evidence a[target="_blank"]');
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe(`${LINK_BASE}/src/routes/orders.ts`);
    expect(link!.getAttribute("rel")).toBe("noopener");
    expect(link!.querySelector("code")!.textContent).toBe("src/routes/orders.ts");
  });

  it("renders evidence paths as plain text without a linkBase", () => {
    const doc = parse(renderDemo());
    expect(doc.querySelectorAll(".cp-evidence a").length).toBe(0);
    expect(doc.querySelector("#u0 .cp-evidence")!.textContent).toContain(
      "src/routes/orders.ts"
    );
  });

  it("composes no links from an unsafe linkBase", () => {
    const change = demoChange();
    const doc = parse(
      renderChangeBook(demoBook(change), change, {
        links: { linkBase: "javascript:alert(1)//" }
      })
    );
    expect(doc.querySelectorAll(".cp-evidence a").length).toBe(0);
  });

  it("keeps hostile evidence paths inert — encoded URL, escaped text", () => {
    const change = hostileChange();
    change.changeUnits[0]!.evidence = [{ path: "<img src=x onerror=alert(1)>.ts" }];
    const html = renderChangeBook(demoBook(change), change, {
      links: { linkBase: LINK_BASE }
    });
    expect(html).not.toContain("<img src=x");
    const doc = parse(html);
    expect(doc.querySelectorAll("img").length).toBe(0);
    const link = doc.querySelector("#u0 .cp-evidence a");
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toContain("%3Cimg%20src%3Dx");
    expect(new URL(link!.getAttribute("href")!).origin).toBe("https://github.com");
  });

  it("stays byte-deterministic with links configured", () => {
    const render = () =>
      renderChangeBook(demoBook(demoChange()), demoChange(), {
        links: { linkBase: LINK_BASE, origin: "https://github.com" }
      });
    expect(render()).toBe(render());
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
