import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import type {
  BookManifest,
  ChangeManifest,
  ChangeUnit,
  Entity,
  Relationship
} from "@gitiviz/schema";
import {
  changeDiagram,
  compileDiagram,
  contextDiagram,
  sequenceDiagram
} from "./diagram.js";
import { layoutGraph, MAX_NODES_PER_ROW } from "./layout.js";
import { renderChangeBook } from "./render.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function entity(id: string, over: Partial<Entity> = {}): Entity {
  return {
    id,
    kind: "module",
    humanLabel: `Label ${id}`,
    baseState: "unchanged",
    headState: "unchanged",
    provenance: "derived",
    ...over
  };
}

function rel(
  id: string,
  from: string,
  to: string,
  verb = "calls",
  over: Partial<Relationship> = {}
): Relationship {
  return {
    id,
    from,
    to,
    verb,
    baseState: "unchanged",
    headState: "unchanged",
    provenance: "derived",
    ...over
  };
}

function changeFixture(): { entities: Entity[]; relationships: Relationship[]; unit: ChangeUnit } {
  const entities = [
    entity("ent-route", {
      kind: "route",
      humanLabel: "Create order endpoint",
      technicalLabel: "POST /orders",
      headState: "added"
    }),
    entity("ent-service", {
      humanLabel: "Order service",
      technicalLabel: "src/services/orderService.ts",
      headState: "changed"
    }),
    entity("ent-legacy", {
      humanLabel: "Legacy checkout",
      technicalLabel: "src/legacy/checkout.ts",
      headState: "removed"
    }),
    entity("ent-db", { kind: "sql-table", humanLabel: "Orders table" })
  ];
  const relationships = [
    rel("rel-1", "ent-route", "ent-service", "creates order via", { headState: "added" }),
    rel("rel-2", "ent-service", "ent-db", "writes to"),
    rel("rel-3", "ent-legacy", "ent-db", "used to write to", { headState: "removed" })
  ];
  const unit: ChangeUnit = {
    id: "unit-1",
    technicalTitle: "feat: add guest checkout route",
    humanTitle: "Guests can now check out",
    provenance: "derived"
  };
  return { entities, relationships, unit };
}

function contextFixture(): { entities: Entity[]; relationships: Relationship[] } {
  const entities = [
    entity("ctx-user", { kind: "person", humanLabel: "Shopper" }),
    entity("ctx-app", { kind: "system", humanLabel: "Shop backend", technicalLabel: "demo-app" }),
    entity("ctx-pay", { kind: "external-system", humanLabel: "Payment provider" })
  ];
  const relationships = [
    rel("ctx-r1", "ctx-user", "ctx-app", "places orders in"),
    rel("ctx-r2", "ctx-app", "ctx-pay", "charges cards via")
  ];
  return { entities, relationships };
}

function parseSvg(svg: string) {
  const window = new Window();
  const parser = new window.DOMParser();
  return parser.parseFromString(`<!doctype html><html><body>${svg}</body></html>`, "text/html");
}

const FORBIDDEN_PATTERNS: Array<[string, RegExp]> = [
  ["script element", /<script/i],
  ["foreignObject", /foreignobject/i],
  ["href attribute (incl. xlink)", /href/i],
  ["xlink namespace", /xlink/i],
  ["javascript: url", /javascript:/i],
  ["css url() reference", /url\(/i],
  ["event handler attribute", /\son[a-z]+=/i],
  ["external http reference", /http:/i],
  ["image element", /<image/i]
];

function expectSafeSvg(svg: string): void {
  for (const [, pattern] of FORBIDDEN_PATTERNS) {
    expect(svg).not.toMatch(pattern);
  }
  const doc = parseSvg(svg);
  const root = doc.querySelector("svg");
  expect(root).not.toBeNull();
  expect(root!.getAttribute("role")).toBe("img");
  expect(root!.getAttribute("aria-label")).toBeTruthy();
  expect(root!.getAttribute("viewBox")).toMatch(/^0 0 \d+ \d+$/);
  expect(root!.getAttribute("style")).toContain("max-width:100%");
  expect(svg).toContain("<title>");
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

describe("layoutGraph", () => {
  it("ranks nodes downward along relationship direction", () => {
    const entities = [entity("a"), entity("b"), entity("c")];
    const relationships = [rel("r1", "a", "b"), rel("r2", "b", "c")];
    const layout = layoutGraph(entities, relationships);
    const y = new Map(layout.nodes.map((n) => [n.entity.id, n.y]));
    expect(y.get("a")!).toBeLessThan(y.get("b")!);
    expect(y.get("b")!).toBeLessThan(y.get("c")!);
  });

  it("wraps ranks at five nodes per row", () => {
    const entities = Array.from({ length: 12 }, (_, i) =>
      entity(`n${String(i).padStart(2, "0")}`)
    );
    const layout = layoutGraph(entities, []);
    const rows = new Map<number, number>();
    for (const node of layout.nodes) {
      rows.set(node.row, (rows.get(node.row) ?? 0) + 1);
    }
    expect(rows.size).toBe(3);
    for (const count of rows.values()) {
      expect(count).toBeLessThanOrEqual(MAX_NODES_PER_ROW);
    }
  });

  it("gives every node a distinct, non-overlapping position", () => {
    const entities = Array.from({ length: 7 }, (_, i) => entity(`n${i}`));
    const layout = layoutGraph(entities, []);
    const seen = new Set(layout.nodes.map((n) => `${n.x},${n.y}`));
    expect(seen.size).toBe(7);
  });

  it("is deterministic regardless of input order", () => {
    const { entities, relationships } = changeFixture();
    const a = layoutGraph(entities, relationships);
    const b = layoutGraph([...entities].reverse(), [...relationships].reverse());
    expect(b).toEqual(a);
  });

  it("ignores self-loops and relationships to unknown entities", () => {
    const entities = [entity("a"), entity("b")];
    const relationships = [
      rel("r1", "a", "a"),
      rel("r2", "a", "ghost"),
      rel("r3", "a", "b")
    ];
    const layout = layoutGraph(entities, relationships);
    expect(layout.edges.length).toBe(1);
    expect(layout.edges[0]!.relationship.id).toBe("r3");
  });

  it("survives relationship cycles", () => {
    const entities = [entity("a"), entity("b")];
    const relationships = [rel("r1", "a", "b"), rel("r2", "b", "a")];
    const layout = layoutGraph(entities, relationships);
    expect(layout.nodes.length).toBe(2);
    expect(layout.edges.length).toBe(2);
  });

  it("gives every edge a polyline and a label midpoint", () => {
    const { entities, relationships } = changeFixture();
    const layout = layoutGraph(entities, relationships);
    for (const edge of layout.edges) {
      expect(edge.points.length).toBeGreaterThanOrEqual(2);
      expect(Number.isFinite(edge.label.x)).toBe(true);
      expect(Number.isFinite(edge.label.y)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Change diagram
// ---------------------------------------------------------------------------

describe("changeDiagram", () => {
  function render(): string {
    const { entities, relationships, unit } = changeFixture();
    return changeDiagram(entities, relationships, unit);
  }

  it("emits well-formed, accessible, self-contained SVG", () => {
    expectSafeSvg(render());
  });

  it("is byte-identical for the same input, even reordered", () => {
    const { entities, relationships, unit } = changeFixture();
    const a = changeDiagram(entities, relationships, unit);
    const b = changeDiagram([...entities].reverse(), [...relationships].reverse(), unit);
    expect(b).toBe(a);
  });

  it("labels every edge with its verb", () => {
    const svg = render();
    const { relationships } = changeFixture();
    for (const relationship of relationships) {
      expect(svg).toContain(`>${relationship.verb}<`);
    }
  });

  it("tags added entities with + New and a dashed border", () => {
    const svg = render();
    expect(svg).toContain("+ New");
    const doc = parseSvg(svg);
    const dashed = Array.from(doc.querySelectorAll("rect")).filter((r) =>
      r.hasAttribute("stroke-dasharray")
    );
    expect(dashed.length).toBeGreaterThan(0);
  });

  it("tags changed entities with ~ Changed", () => {
    expect(render()).toContain("~ Changed");
  });

  it("fades and strikes removed entities", () => {
    const svg = render();
    expect(svg).toContain("− Removed");
    expect(svg).toContain('text-decoration="line-through"');
    const doc = parseSvg(svg);
    const faded = Array.from(doc.querySelectorAll("g")).filter((g) => {
      const opacity = g.getAttribute("opacity");
      return opacity !== null && Number(opacity) < 1;
    });
    expect(faded.length).toBeGreaterThan(0);
  });

  it("keeps unchanged entities quiet: no state tag", () => {
    const svg = render();
    expect(svg).not.toContain("= Unchanged");
  });

  it("shows human label bold with technical sublabel", () => {
    const svg = render();
    expect(svg).toContain("Order service");
    expect(svg).toContain("POST /orders");
    expect(svg).toContain('font-weight="600"');
  });

  it("escapes hostile labels and verbs", () => {
    const { entities, relationships, unit } = changeFixture();
    entities[0] = {
      ...entities[0]!,
      humanLabel: '<script>alert("x")</script>',
      technicalLabel: '<img src=x onerror=alert(1)>.ts'
    };
    relationships[0] = { ...relationships[0]!, verb: '"><script>steal()</script>' };
    const hostileUnit: ChangeUnit = { ...unit, humanTitle: '"><svg onload=alert(2)>' };
    const svg = changeDiagram(entities, relationships, hostileUnit);
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain("<img");
    const doc = parseSvg(svg);
    expect(doc.querySelectorAll("script").length).toBe(0);
    expect(doc.querySelectorAll("img").length).toBe(0);
    // Hostile markup must never become elements or event-handler attributes.
    for (const el of Array.from(doc.body.querySelectorAll("*"))) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.name.startsWith("on")).toBe(false);
      }
    }
    expect(doc.body.textContent).toContain('<script>alert("x")</script>');
  });
});

// ---------------------------------------------------------------------------
// Context diagram
// ---------------------------------------------------------------------------

describe("contextDiagram", () => {
  function render(): string {
    const { entities, relationships } = contextFixture();
    return contextDiagram(entities, relationships);
  }

  it("emits well-formed, accessible, self-contained SVG", () => {
    expectSafeSvg(render());
  });

  it("is deterministic", () => {
    const { entities, relationships } = contextFixture();
    const a = contextDiagram(entities, relationships);
    const b = contextDiagram([...entities].reverse(), [...relationships].reverse());
    expect(b).toBe(a);
  });

  it("styles person and external-system boxes with kind tags", () => {
    const svg = render();
    expect(svg).toContain("Person");
    expect(svg).toContain("External");
  });

  it("draws a boundary rectangle around the application", () => {
    const svg = render();
    expect(svg).toContain("System boundary");
    const doc = parseSvg(svg);
    const rects = doc.querySelectorAll("rect");
    // boundary + one rect per entity
    expect(rects.length).toBe(contextFixture().entities.length + 1);
  });

  it("labels every edge with its verb", () => {
    const svg = render();
    expect(svg).toContain(">places orders in<");
    expect(svg).toContain(">charges cards via<");
  });

  it("escapes hostile labels", () => {
    const { entities, relationships } = contextFixture();
    entities[1] = { ...entities[1]!, humanLabel: "</text><script>alert(1)</script>" };
    const svg = contextDiagram(entities, relationships);
    expect(svg).not.toContain("<script>");
    expect(parseSvg(svg).querySelectorAll("script").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Sequence lanes
// ---------------------------------------------------------------------------

describe("sequenceDiagram", () => {
  const lanes = [
    { id: "browser", humanLabel: "Browser" },
    { id: "api", humanLabel: "API", technicalLabel: "src/routes" },
    { id: "db", humanLabel: "Database" }
  ];
  const steps = [
    { from: "browser", to: "api", text: "submit order" },
    { from: "api", to: "db", text: "insert row" },
    { from: "api", to: "browser", text: "confirm" }
  ];

  it("emits well-formed, accessible, self-contained SVG", () => {
    expectSafeSvg(sequenceDiagram(lanes, steps));
  });

  it("numbers every step in order", () => {
    const svg = sequenceDiagram(lanes, steps);
    expect(svg).toContain("1. submit order");
    expect(svg).toContain("2. insert row");
    expect(svg).toContain("3. confirm");
  });

  it("renders one header per lane", () => {
    const svg = sequenceDiagram(lanes, steps);
    for (const lane of lanes) {
      expect(svg).toContain(lane.humanLabel);
    }
  });

  it("is deterministic", () => {
    expect(sequenceDiagram(lanes, steps)).toBe(sequenceDiagram(lanes, steps));
  });

  it("rejects fewer than 2 or more than 4 lanes", () => {
    expect(() => sequenceDiagram([lanes[0]!], steps)).toThrow(RangeError);
    expect(() =>
      sequenceDiagram(
        [
          ...lanes,
          { id: "x", humanLabel: "X" },
          { id: "y", humanLabel: "Y" }
        ],
        []
      )
    ).toThrow(RangeError);
  });

  it("fails loudly on steps referencing unknown lanes", () => {
    expect(() =>
      sequenceDiagram(lanes, [{ from: "browser", to: "ghost", text: "boom" }])
    ).toThrow(/unknown lane/);
  });

  it("handles self-directed steps without crashing", () => {
    const svg = sequenceDiagram(lanes, [{ from: "api", to: "api", text: "validate" }]);
    expect(svg).toContain("1. validate");
    expectSafeSvg(svg);
  });

  it("escapes hostile step text and lane labels", () => {
    const svg = sequenceDiagram(
      [
        { id: "a", humanLabel: "<script>alert(1)</script>" },
        { id: "b", humanLabel: "B" }
      ],
      [{ from: "a", to: "b", text: '"><script>steal()</script>' }]
    );
    expect(svg).not.toContain("<script>");
    expect(parseSvg(svg).querySelectorAll("script").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// compileDiagram + renderChangeBook integration
// ---------------------------------------------------------------------------

describe("compileDiagram", () => {
  it("returns null for an empty projection (placeholder renders instead)", () => {
    expect(compileDiagram({ kind: "change", entities: [], relationships: [] })).toBeNull();
  });

  it("compiles context and change projections", () => {
    const ctx = contextFixture();
    const chg = changeFixture();
    const contextSvg = compileDiagram({
      kind: "context",
      entities: ctx.entities,
      relationships: ctx.relationships
    });
    const changeSvg = compileDiagram({
      kind: "change",
      entities: chg.entities,
      relationships: chg.relationships,
      changeUnit: chg.unit
    });
    expect(contextSvg).not.toBeNull();
    expect(changeSvg).not.toBeNull();
    expectSafeSvg(contextSvg!);
    expectSafeSvg(changeSvg!);
  });

  it("plugs into renderChangeBook as the diagram callback", () => {
    const { entities, relationships, unit } = changeFixture();
    const change: ChangeManifest = {
      specVersion: "0.1.0",
      repository: { name: "demo-app" },
      baseRevision: "a".repeat(40),
      headRevision: "b".repeat(40),
      entities,
      relationships,
      changeUnits: [
        { ...unit, entities: entities.map((e) => e.id), relationships: relationships.map((r) => r.id) }
      ],
      analysisLimitations: []
    };
    const book: BookManifest = {
      specVersion: "0.1.0",
      repository: { name: "demo-app" },
      chapters: [{ id: "systems", title: "Systems", status: "generated" }]
    };
    const html = renderChangeBook(book, change, { renderDiagram: compileDiagram });
    const window = new Window();
    const doc = new window.DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelectorAll("script").length).toBe(0);
    // The architecture view compiles the context diagram.
    expect(doc.querySelectorAll("figure.diagram svg").length).toBeGreaterThanOrEqual(1);
    expect(doc.querySelectorAll("figure.diagram-placeholder").length).toBe(0);
  });
});
