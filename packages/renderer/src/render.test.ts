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
});

// ---------------------------------------------------------------------------
// Masthead
// ---------------------------------------------------------------------------

describe("masthead", () => {
  it("shows kicker, repository display name, and a human subtitle", () => {
    const doc = parse(renderDemo());
    const header = doc.querySelector("header.masthead");
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
});

// ---------------------------------------------------------------------------
// Navigation grouping and labels
// ---------------------------------------------------------------------------

describe("navigation grouping and labels", () => {
  it("groups the nav into 'This change' and 'The book' clusters", () => {
    const doc = parse(renderDemo());
    const groups = doc.querySelectorAll("nav .nav-group");
    expect(groups.length).toBe(2);
    expect(groups[0]!.querySelector(".nav-group-label")!.textContent).toBe("This change");
    expect(groups[1]!.querySelector(".nav-group-label")!.textContent).toBe("The book");
    // Overview + 2 meaningful change units; the ten canonical book chapters.
    expect(groups[0]!.querySelectorAll("label").length).toBe(3);
    expect(groups[1]!.querySelectorAll("label").length).toBe(10);
  });

  it("numbers change-chapter nav labels and keeps them short", () => {
    const doc = parse(renderDemo());
    const labels = Array.from(doc.querySelectorAll("nav label")).map(
      (label) => label.textContent
    );
    expect(labels[0]).toBe("Overview");
    expect(labels[1]).toBe("1 · Guests can now check out");
    expect(labels[2]).toBe("2 · refactor: rename order helpers");
  });

  it("truncates long titles on a word boundary in the nav; the heading keeps the full title", () => {
    const change = demoChange();
    change.changeUnits[0]!.humanTitle =
      "Guests can now check out without creating an account first";
    const doc = parse(renderChangeBook(demoBook(change), change));
    const label = Array.from(doc.querySelectorAll("nav label")).find((l) =>
      l.textContent.startsWith("1 · ")
    )!;
    expect(label.textContent).toBe("1 · Guests can now check out…");
    const headings = Array.from(doc.querySelectorAll("h2")).map((h) => h.textContent);
    expect(headings).toContain(
      "Guests can now check out without creating an account first"
    );
  });

  it("styles nav labels as compact pills with a clear active state", () => {
    const css = parse(renderDemo()).querySelector("style")!.textContent;
    expect(css).toMatch(/nav label\{[^}]*cursor:pointer/);
    expect(css).toMatch(/nav label\{[^}]*border-radius:999px/);
    // Active state pairs the checked radio with its nav pill.
    expect(css).toContain('#c0:checked~nav label[for="c0"]');
  });
});

// ---------------------------------------------------------------------------
// Commit timeline
// ---------------------------------------------------------------------------

describe("commit timeline", () => {
  it("shows one node per meaningful unit using the narrated human title", () => {
    const doc = parse(renderDemo());
    const titles = Array.from(
      doc.querySelector("ol.timeline")!.querySelectorAll(".timeline-title")
    ).map((t) => t.textContent);
    expect(titles).toEqual([
      "Guests can now check out",
      "refactor: rename order helpers"
    ]);
  });

  it("attaches the short commit sha as muted evidence on each node", () => {
    const doc = parse(renderDemo());
    const shas = Array.from(
      doc.querySelector("ol.timeline")!.querySelectorAll("code.timeline-sha")
    ).map((c) => c.textContent);
    expect(shas).toContain("ccccccc");
    for (const sha of shas) expect(sha.length).toBe(7);
  });

  it("collapses grouped commits under a closed housekeeping details element", () => {
    const doc = parse(renderDemo());
    const overview = doc.querySelector("main > section")!;
    const housekeeping = overview.querySelector("details.housekeeping");
    expect(housekeeping).not.toBeNull();
    expect(housekeeping!.hasAttribute("open")).toBe(false);
    expect(housekeeping!.querySelector("summary")!.textContent).toBe(
      "1 housekeeping commit"
    );
    expect(housekeeping!.textContent).toContain("fixup! feat: add guest checkout route");
    // Grouped commits never appear as primary timeline nodes.
    expect(overview.querySelector("ol.timeline")!.textContent).not.toContain("fixup!");
  });
});

// ---------------------------------------------------------------------------
// Chapter questions
// ---------------------------------------------------------------------------

describe("chapter questions", () => {
  it("puts the principal question under the overview heading", () => {
    const doc = parse(renderDemo());
    const overview = doc.querySelector("main > section")!;
    expect(overview.querySelector(".chapter-sub")!.textContent).toBe(
      "What changed, and why does it matter?"
    );
  });

  it("gives every book chapter its principal question as a subtitle", () => {
    const doc = parse(renderDemo());
    const text = doc.body.textContent;
    expect(text).toContain("Why does this system exist?");
    expect(text).toContain("What are the parts, and how do they fit together?");
    expect(text).toContain("How did it get here?");
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

  it("badges narrated (inferred) chapters with ◇ AI interpretation and a title attribute", () => {
    const change = demoChange();
    change.changeUnits[0]!.provenance = "inferred";
    const doc = parse(renderChangeBook(demoBook(change), change));
    const badge = doc.querySelector(".badge.badge-inferred");
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe("◇ AI interpretation");
    expect(badge!.getAttribute("title")).toContain("AI interpretation");
    // The timeline node for the narrated unit carries the ◇ glyph too.
    expect(doc.querySelector("ol.timeline")!.textContent).toContain("◇");
  });
});

// ---------------------------------------------------------------------------
// Chapters and CSS-only navigation
// ---------------------------------------------------------------------------

describe("chapter navigation (scriptless)", () => {
  it("renders one section per chapter: overview + meaningful units + ten book chapters", () => {
    const doc = parse(renderDemo());
    const sections = doc.querySelectorAll("main > section");
    // 1 overview + 2 meaningful change units (unit-3 is grouped) + 10 book chapters
    expect(sections.length).toBe(13);
  });

  it("selects exactly one chapter by default via a checked radio", () => {
    const doc = parse(renderDemo());
    const radios = doc.querySelectorAll('input[type="radio"][name="chapter"]');
    expect(radios.length).toBe(13);
    const checked = Array.from(radios).filter((r) => r.hasAttribute("checked"));
    expect(checked.length).toBe(1);
    // The overview opens first.
    expect(checked[0]!.getAttribute("id")).toBe(doc.querySelectorAll("input")[0]!.getAttribute("id"));
  });

  it("hides all sections by default and reveals exactly the checked one via CSS", () => {
    const html = renderDemo();
    const doc = parse(html);
    const css = doc.querySelector("style")!.textContent;
    expect(css).toContain("main > section{display:none");
    const sections = Array.from(doc.querySelectorAll("main > section"));
    const radios = Array.from(doc.querySelectorAll('input[type="radio"][name="chapter"]'));
    // One reveal rule per chapter, pairing radio id to section id.
    for (let i = 0; i < radios.length; i++) {
      const radioId = radios[i]!.getAttribute("id");
      const sectionId = sections[i]!.getAttribute("id");
      expect(css).toContain(`#${radioId}:checked~#${sectionId}{display:block`);
    }
  });

  it("navigation uses native labels bound to the radios, no click-handler divs", () => {
    const doc = parse(renderDemo());
    const labels = doc.querySelectorAll("nav label[for]");
    expect(labels.length).toBe(13);
    for (const label of Array.from(labels)) {
      const target = doc.getElementById(label.getAttribute("for")!);
      expect(target).not.toBeNull();
      expect(target!.tagName.toLowerCase()).toBe("input");
    }
  });

  it("gives every chapter except the first a Previous label targeting the prior radio", () => {
    const doc = parse(renderDemo());
    const sections = Array.from(doc.querySelectorAll("main > section"));
    expect(sections.length).toBeGreaterThan(1);
    sections.forEach((section, i) => {
      const prev = section.querySelector("label.pager-prev");
      if (i === 0) {
        expect(prev, "first chapter must not offer Previous").toBeNull();
      } else {
        expect(prev, `chapter ${i} missing Previous`).not.toBeNull();
        expect(prev!.getAttribute("for")).toBe(`c${i - 1}`);
        expect(prev!.textContent).toContain("Previous");
      }
    });
  });

  it("gives every chapter except the last a Next label targeting the next radio", () => {
    const doc = parse(renderDemo());
    const sections = Array.from(doc.querySelectorAll("main > section"));
    const last = sections.length - 1;
    sections.forEach((section, i) => {
      const next = section.querySelector("label.pager-next");
      if (i === last) {
        expect(next, "last chapter must not offer Next").toBeNull();
      } else {
        expect(next, `chapter ${i} missing Next`).not.toBeNull();
        expect(next!.getAttribute("for")).toBe(`c${i + 1}`);
        expect(next!.textContent).toContain("Next");
      }
    });
  });

  it("pager labels target existing chapter radios and add no scripts", () => {
    const doc = parse(renderDemo());
    const pagerLabels = Array.from(
      doc.querySelectorAll("label.pager-prev, label.pager-next")
    );
    expect(pagerLabels.length).toBeGreaterThan(0);
    for (const label of pagerLabels) {
      const target = doc.getElementById(label.getAttribute("for")!);
      expect(target).not.toBeNull();
      expect(target!.tagName.toLowerCase()).toBe("input");
      expect(target!.getAttribute("name")).toBe("chapter");
    }
    expect(doc.querySelectorAll("script").length).toBe(0);
  });

  it("stays byte-deterministic with the pager present", () => {
    expect(renderDemo()).toBe(renderDemo());
  });

  it("grouped change units get no chapter but stay in the overview timeline", () => {
    const doc = parse(renderDemo());
    const overview = doc.querySelector("main > section")!;
    expect(overview.textContent).toContain("fixup! feat: add guest checkout route");
    expect(overview.textContent).toContain("fixup commit");
    // No dedicated section mentions the fixup title beyond the timelines.
    const sections = Array.from(doc.querySelectorAll("main > section"));
    const headings = sections.map((s) => s.querySelector("h2")?.textContent ?? "");
    expect(headings.some((h) => h.includes("fixup!"))).toBe(false);
  });

  it("book chapters marked not-written say so honestly", () => {
    const doc = parse(renderDemo());
    const text = doc.body.textContent;
    expect(text).toContain("Not yet written");
  });
});

// ---------------------------------------------------------------------------
// Chapter content
// ---------------------------------------------------------------------------

describe("chapter content", () => {
  it("overview states repo, revisions, and meaningful change count", () => {
    const doc = parse(renderDemo());
    const overview = doc.querySelector("main > section")!;
    expect(overview.textContent).toContain("demo-app");
    expect(overview.textContent).toContain("aaaaaaaaaa".slice(0, 10));
    expect(overview.textContent).toContain("2 meaningful changes");
  });

  it("change chapters prefer human titles and show narration", () => {
    const doc = parse(renderDemo());
    const text = doc.body.textContent;
    expect(text).toContain("Guests can now check out");
    expect(text).toContain("Adds a POST /orders route with validation.");
    expect(text).toContain("Only registered users could order.");
    expect(text).toContain("Guests can place orders too.");
    expect(text).toContain("Guests no longer need an account.");
  });

  it("falls back to the technical title when no human title exists", () => {
    const doc = parse(renderDemo());
    expect(doc.body.textContent).toContain("refactor: rename order helpers");
  });

  it("change chapters list what stayed unchanged", () => {
    const doc = parse(renderDemo());
    const text = doc.body.textContent;
    expect(text).toContain("Orders table");
  });

  it("evidence sits inside closed details elements", () => {
    const doc = parse(renderDemo());
    const details = doc.querySelectorAll("details");
    expect(details.length).toBeGreaterThan(0);
    for (const d of Array.from(details)) {
      expect(d.hasAttribute("open")).toBe(false);
    }
    expect(doc.body.textContent).toContain("src/routes/orders.ts");
  });
});

// ---------------------------------------------------------------------------
// Diagram insertion point (Task 15b plugs in here)
// ---------------------------------------------------------------------------

describe("diagram insertion point", () => {
  it("invokes the renderDiagram callback for systems and change chapters", () => {
    const requests: DiagramRequest[] = [];
    const html = renderDemo({
      renderDiagram: (req) => {
        requests.push(req);
        return `<svg role="img" aria-label="diagram" viewBox="0 0 10 10"></svg>`;
      }
    });
    const kinds = requests.map((r) => r.kind);
    expect(kinds).toContain("context");
    expect(kinds.filter((k) => k === "change").length).toBe(2);
    const changeReq = requests.find((r) => r.kind === "change" && r.changeUnit?.id === "unit-1")!;
    expect(changeReq.entities.map((e) => e.id).sort()).toEqual(["ent-route", "ent-service"]);
    expect(changeReq.relationships.map((r) => r.id)).toEqual(["rel-1"]);
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
