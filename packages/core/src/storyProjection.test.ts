import { describe, it, expect } from "vitest";
import type { ChangeUnit, Entity, Relationship } from "@gitiviz/schema";
import {
  MAX_STORY_NODES,
  buildOverviewStory,
  buildUnitStory
} from "./storyProjection.js";

// ---------------------------------------------------------------------------
// Fixture helpers: hand-built entities/relationships in the exact shape the
// evidence graph emits (system contains file; file defines/imports fact).
// ---------------------------------------------------------------------------

let seq = 0;
const id = (): string => `id${String(seq++).padStart(4, "0")}`;

function entity(
  kind: string,
  humanLabel: string,
  headState: Entity["headState"],
  overrides: Partial<Entity> = {}
): Entity {
  const baseState: Entity["baseState"] =
    headState === "added"
      ? "removed"
      : headState === "removed"
        ? "added"
        : headState;
  return {
    id: id(),
    kind,
    humanLabel,
    technicalLabel: humanLabel,
    baseState,
    headState,
    provenance: "derived",
    ...overrides
  };
}

function rel(
  verb: string,
  from: string,
  to: string,
  headState: Relationship["headState"] = "unchanged"
): Relationship {
  const baseState: Relationship["baseState"] =
    headState === "added"
      ? "removed"
      : headState === "removed"
        ? "added"
        : headState;
  return {
    id: id(),
    from,
    to,
    verb,
    baseState,
    headState,
    provenance: "derived"
  };
}

/** One system with `n` changed files under it. Returns everything created. */
function systemWithFiles(
  label: string,
  fileStates: Entity["headState"][]
): { system: Entity; files: Entity[]; rels: Relationship[] } {
  const system = entity("system", label, "changed");
  const files = fileStates.map((s, i) => entity("file", `${label}/f${i}.ts`, s));
  const rels = files.map((f) => rel("contains", system.id, f.id));
  return { system, files, rels };
}

function unitOf(entities: Entity[]): ChangeUnit {
  return {
    id: "unit1",
    technicalTitle: "feat: something",
    type: "commit",
    entities: entities.map((e) => e.id).sort(),
    provenance: "derived"
  };
}

describe("buildOverviewStory", () => {
  it("rolls files, symbols and modules up into system nodes only", () => {
    const { system, files, rels } = systemWithFiles("Renderer", ["changed"]);
    const symbol = entity("symbol", "renderPage", "added");
    const module = entity("module", "node:crypto", "added");
    const all = [system, ...files, symbol, module];
    const links = [
      ...rels,
      rel("defines", files[0]!.id, symbol.id, "added"),
      rel("imports", files[0]!.id, module.id, "added")
    ];

    const story = buildOverviewStory(all, links);

    expect(story.nodes).toHaveLength(1);
    expect(story.nodes[0]!.humanLabel).toBe("Renderer");
    expect(story.nodes[0]!.count).toBe(3); // file + symbol + module
    // No node ever surfaces a file/module/symbol label or kind.
    for (const node of story.nodes) {
      expect(node.humanLabel).not.toMatch(/\.ts$/);
      expect(node.humanLabel).not.toBe("renderPage");
      expect(node.humanLabel).not.toBe("node:crypto");
      expect(["file", "module", "symbol"]).not.toContain(node.kind);
    }
  });

  it("uses the dominant change state for a rolled-up node", () => {
    const { system, files, rels } = systemWithFiles("Cli", [
      "added",
      "added",
      "changed"
    ]);
    const story = buildOverviewStory([system, ...files], rels);
    expect(story.nodes[0]!.changeState).toBe("added");
    expect(story.nodes[0]!.count).toBe(3);
  });

  it("ignores unchanged entities entirely", () => {
    const system = entity("system", "Docs", "changed");
    const touched = entity("file", "docs/a.md", "changed");
    const untouched = entity("file", "docs/b.md", "unchanged");
    const links = [
      rel("contains", system.id, touched.id),
      rel("contains", system.id, untouched.id)
    ];
    const story = buildOverviewStory([system, touched, untouched], links);
    expect(story.nodes[0]!.count).toBe(1);
  });

  it("caps nodes at 7, folding the least-changed into an overflow node", () => {
    const all: Entity[] = [];
    const links: Relationship[] = [];
    // 9 systems; "Area0" has the most changes, "Area8" the least.
    for (let i = 0; i < 9; i++) {
      const made = systemWithFiles(
        `Area${i}`,
        Array<Entity["headState"]>(9 - i).fill("changed")
      );
      all.push(made.system, ...made.files);
      links.push(...made.rels);
    }

    const story = buildOverviewStory(all, links);

    expect(story.nodes.length).toBeLessThanOrEqual(MAX_STORY_NODES);
    expect(story.nodes).toHaveLength(7);
    const last = story.nodes[story.nodes.length - 1]!;
    expect(last.humanLabel).toBe("…and 3 more areas");
    expect(last.count).toBe(3 + 2 + 1); // the three least-changed areas
    // Most-changed areas survive, least-changed are folded.
    const labels = story.nodes.map((n) => n.humanLabel);
    expect(labels).toContain("Area0");
    expect(labels).not.toContain("Area8");
  });

  it("emits an edge with a plain verb when a system gains a dependency", () => {
    const a = systemWithFiles("Renderer", ["changed"]);
    const b = systemWithFiles("Core", ["changed"]);
    const symbol = entity("symbol", "buildStory", "added");
    const all = [a.system, ...a.files, b.system, ...b.files, symbol];
    const links = [
      ...a.rels,
      ...b.rels,
      // Core defines the symbol; the Renderer file now imports it.
      rel("defines", b.files[0]!.id, symbol.id, "added"),
      rel("imports", a.files[0]!.id, symbol.id, "added")
    ];

    const story = buildOverviewStory(all, links);

    expect(story.edges).toHaveLength(1);
    const edge = story.edges[0]!;
    const from = story.nodes.find((n) => n.id === edge.from)!;
    const to = story.nodes.find((n) => n.id === edge.to)!;
    expect(from.humanLabel).toBe("Renderer");
    expect(to.humanLabel).toBe("Core");
    expect(edge.verb).toBe("now uses");
  });

  it("emits no edge for unchanged relationships or within one system", () => {
    const a = systemWithFiles("Renderer", ["changed", "changed"]);
    const symbol = entity("symbol", "helper", "changed");
    const links = [
      ...a.rels,
      // Same-system link and an unchanged cross-file link.
      rel("defines", a.files[0]!.id, symbol.id, "changed"),
      rel("imports", a.files[1]!.id, symbol.id)
    ];
    const story = buildOverviewStory([a.system, ...a.files, symbol], links);
    expect(story.edges).toHaveLength(0);
  });

  it("is deterministic regardless of input order", () => {
    const a = systemWithFiles("Renderer", ["changed", "added"]);
    const b = systemWithFiles("Cli", ["removed"]);
    const all = [a.system, ...a.files, b.system, ...b.files];
    const links = [...a.rels, ...b.rels];

    const forward = buildOverviewStory(all, links);
    const reversed = buildOverviewStory(
      [...all].reverse(),
      [...links].reverse()
    );
    expect(reversed).toEqual(forward);
  });

  it("passes hostile labels through as plain data, unmodified", () => {
    const hostile = `<script>alert(1)</script>`;
    const { system, files, rels } = systemWithFiles(hostile, ["changed"]);
    const story = buildOverviewStory([system, ...files], rels);
    expect(story.nodes[0]!.humanLabel).toBe(hostile);
  });

  it("buckets changed entities with no owning system into 'Other changes'", () => {
    const orphan = entity("route", "POST /orders", "added");
    const story = buildOverviewStory([orphan], []);
    expect(story.nodes).toHaveLength(1);
    expect(story.nodes[0]!.humanLabel).toBe("Other changes");
    expect(story.nodes[0]!.count).toBe(1);
  });
});

describe("buildUnitStory", () => {
  it("only counts entities attached to the unit", () => {
    const a = systemWithFiles("Renderer", ["changed", "changed"]);
    const b = systemWithFiles("Cli", ["changed"]);
    const all = [a.system, ...a.files, b.system, ...b.files];
    const links = [...a.rels, ...b.rels];
    // The unit only touched one Renderer file.
    const unit = unitOf([a.files[0]!]);

    const story = buildUnitStory(unit, all, links);

    expect(story.nodes).toHaveLength(1);
    expect(story.nodes[0]!.humanLabel).toBe("Renderer");
    expect(story.nodes[0]!.count).toBe(1);
  });

  it("only keeps edges whose endpoints are both in the unit", () => {
    const a = systemWithFiles("Renderer", ["changed"]);
    const b = systemWithFiles("Core", ["changed"]);
    const symbol = entity("symbol", "buildStory", "added");
    const all = [a.system, ...a.files, b.system, ...b.files, symbol];
    const links = [
      ...a.rels,
      ...b.rels,
      rel("defines", b.files[0]!.id, symbol.id, "added"),
      rel("imports", a.files[0]!.id, symbol.id, "added")
    ];

    const withBoth = buildUnitStory(
      unitOf([a.files[0]!, b.files[0]!, symbol]),
      all,
      links
    );
    expect(withBoth.edges).toHaveLength(1);

    const withoutSymbol = buildUnitStory(
      unitOf([a.files[0]!, b.files[0]!]),
      all,
      links
    );
    expect(withoutSymbol.edges).toHaveLength(0);
  });

  it("enforces the 7-node cap on unit stories too", () => {
    const all: Entity[] = [];
    const links: Relationship[] = [];
    const attached: Entity[] = [];
    for (let i = 0; i < 10; i++) {
      const made = systemWithFiles(`Zone${i}`, ["changed", "changed"]);
      all.push(made.system, ...made.files);
      links.push(...made.rels);
      attached.push(...made.files);
    }

    const story = buildUnitStory(unitOf(attached), all, links);

    expect(story.nodes).toHaveLength(MAX_STORY_NODES);
    const last = story.nodes[story.nodes.length - 1]!;
    expect(last.humanLabel).toBe("…and 4 more areas");
    expect(last.count).toBe(8);
    for (const node of story.nodes) {
      expect(["file", "module", "symbol"]).not.toContain(node.kind);
    }
  });

  it("returns an empty story for a unit with no attached entities", () => {
    const a = systemWithFiles("Renderer", ["changed"]);
    const story = buildUnitStory(
      unitOf([]),
      [a.system, ...a.files],
      a.rels
    );
    expect(story.nodes).toHaveLength(0);
    expect(story.edges).toHaveLength(0);
  });
});
