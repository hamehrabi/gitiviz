import { describe, it, expect } from "vitest";
import type { FileChange } from "@gitiviz/git";
import { importExportAnalyzer, routeAnalyzer, type AnalyzerFact } from "@gitiviz/analyzers";
import { buildEvidenceGraph } from "./graph.js";

/** Run the real analyzers over one side's content of one file. */
function factsFor(path: string, content: string): AnalyzerFact[] {
  const facts: AnalyzerFact[] = [];
  for (const analyzer of [routeAnalyzer, importExportAnalyzer]) {
    if (analyzer.appliesTo(path)) {
      facts.push(...analyzer.analyze({ path, content }).facts);
    }
  }
  return facts;
}

const modified = (path: string, extra: Partial<FileChange> = {}): FileChange => ({
  path,
  status: "modified",
  baseBlob: "a".repeat(40),
  headBlob: "b".repeat(40),
  ...extra
});

describe("buildEvidenceGraph", () => {
  it("turns an added route into a route entity with headState added", () => {
    const path = "src/routes/orders.ts";
    const base = `export function listOrders() {}\n`;
    const head = `export function listOrders() {}\napp.post("/orders", handler);\n`;
    const graph = buildEvidenceGraph({
      fileChanges: [modified(path)],
      baseFacts: factsFor(path, base),
      headFacts: factsFor(path, head)
    });

    const route = graph.entities.find((e) => e.kind === "route");
    expect(route).toBeDefined();
    expect(route!.technicalLabel).toBe("POST /orders");
    expect(route!.headState).toBe("added");
    expect(route!.baseState).toBe("removed");
    expect(route!.provenance).toBe("derived");
    expect(route!.evidence?.some((a) => a.path === path && a.range?.startLine === 2)).toBe(true);
  });

  it("keeps a stable entity id for a symbol that survives a file rename", () => {
    const content = `export function createOrder() {}\n`;

    const before = buildEvidenceGraph({
      fileChanges: [modified("src/services/order.ts")],
      baseFacts: factsFor("src/services/order.ts", content),
      headFacts: factsFor("src/services/order.ts", content)
    });
    const after = buildEvidenceGraph({
      fileChanges: [
        modified("src/services/orderService.ts", {
          status: "renamed",
          oldPath: "src/services/order.ts"
        })
      ],
      baseFacts: factsFor("src/services/order.ts", content),
      headFacts: factsFor("src/services/orderService.ts", content)
    });

    const symBefore = before.entities.find((e) => e.kind === "symbol");
    const symAfter = after.entities.find((e) => e.kind === "symbol");
    expect(symBefore).toBeDefined();
    expect(symAfter).toBeDefined();
    expect(symAfter!.id).toBe(symBefore!.id);
    // Same symbol on both sides: unchanged, even though the file moved.
    expect(symAfter!.baseState).toBe("unchanged");
    expect(symAfter!.headState).toBe("unchanged");
  });

  it("marks entities from a deleted file as removed at head", () => {
    const path = "src/routes/legacy.ts";
    const base = `app.get("/legacy", handler);\n`;
    const graph = buildEvidenceGraph({
      fileChanges: [{ path, status: "deleted", baseBlob: "c".repeat(40) }],
      baseFacts: factsFor(path, base),
      headFacts: []
    });

    const file = graph.entities.find((e) => e.kind === "file");
    expect(file).toBeDefined();
    expect(file!.headState).toBe("removed");

    const route = graph.entities.find((e) => e.kind === "route");
    expect(route).toBeDefined();
    expect(route!.headState).toBe("removed");
  });

  it("rolls files up into one system entity per source directory", () => {
    const graph = buildEvidenceGraph({
      fileChanges: [
        modified("src/routes/orders.ts", { status: "added", baseBlob: undefined }),
        modified("src/routes/users.ts")
      ],
      baseFacts: [],
      headFacts: []
    });

    const systems = graph.entities.filter((e) => e.kind === "system");
    expect(systems).toHaveLength(1);
    expect(systems[0]!.technicalLabel).toBe("src/routes");
    expect(systems[0]!.humanLabel).toBe("Routes");

    const contains = graph.relationships.filter((r) => r.verb === "contains");
    expect(contains).toHaveLength(2);
    for (const rel of contains) {
      expect(rel.from).toBe(systems[0]!.id);
    }
  });

  it("groups root-level files under a project-root system", () => {
    const graph = buildEvidenceGraph({
      fileChanges: [modified("package.json")],
      baseFacts: [],
      headFacts: []
    });
    const system = graph.entities.find((e) => e.kind === "system");
    expect(system).toBeDefined();
    expect(system!.humanLabel).toBe("Project root");
  });

  it("stamps every entity and relationship as derived with evidence on entities", () => {
    const path = "src/routes/orders.ts";
    const head = `import express from "express";\napp.post("/orders", handler);\n`;
    const graph = buildEvidenceGraph({
      fileChanges: [modified(path, { status: "added", baseBlob: undefined })],
      baseFacts: [],
      headFacts: factsFor(path, head)
    });

    expect(graph.entities.length).toBeGreaterThan(0);
    expect(graph.relationships.length).toBeGreaterThan(0);
    for (const entity of graph.entities) {
      expect(entity.provenance).toBe("derived");
      expect(entity.confidence).toBeUndefined();
      expect(entity.evidence && entity.evidence.length > 0).toBe(true);
    }
    for (const rel of graph.relationships) {
      expect(rel.provenance).toBe("derived");
      expect(rel.verb.length).toBeGreaterThan(0);
    }
  });

  it("turns imports into module entities and imports relationships", () => {
    const path = "src/routes/orders.ts";
    const head = `import express from "express";\n`;
    const graph = buildEvidenceGraph({
      fileChanges: [modified(path, { status: "added", baseBlob: undefined })],
      baseFacts: [],
      headFacts: factsFor(path, head)
    });

    const mod = graph.entities.find((e) => e.kind === "module");
    const file = graph.entities.find((e) => e.kind === "file");
    expect(mod).toBeDefined();
    expect(mod!.technicalLabel).toBe("express");
    const imports = graph.relationships.find((r) => r.verb === "imports");
    expect(imports).toBeDefined();
    expect(imports!.from).toBe(file!.id);
    expect(imports!.to).toBe(mod!.id);
  });

  it("marks a fact whose content changed as changed on both sides", () => {
    const path = "package.json";
    const depFact = (version: string): AnalyzerFact => ({
      kind: "package",
      value: { role: "dependency", name: "express", version, section: "dependencies" },
      anchor: { path, startLine: 5, endLine: 5 }
    });
    const graph = buildEvidenceGraph({
      fileChanges: [modified(path)],
      baseFacts: [depFact("^4.0.0")],
      headFacts: [depFact("^5.0.0")]
    });

    const pkg = graph.entities.find((e) => e.kind === "package");
    expect(pkg).toBeDefined();
    expect(pkg!.baseState).toBe("changed");
    expect(pkg!.headState).toBe("changed");
  });

  it("keeps a surviving route unchanged inside a modified file", () => {
    const path = "src/routes/orders.ts";
    const base = `app.get("/orders", list);\n`;
    const head = `app.get("/orders", list);\napp.post("/orders", create);\n`;
    const graph = buildEvidenceGraph({
      fileChanges: [modified(path)],
      baseFacts: factsFor(path, base),
      headFacts: factsFor(path, head)
    });

    const unchanged = graph.entities.find((e) => e.technicalLabel === "GET /orders");
    expect(unchanged).toBeDefined();
    expect(unchanged!.baseState).toBe("unchanged");
    expect(unchanged!.headState).toBe("unchanged");
  });

  it("is deterministic regardless of input order", () => {
    const path = "src/routes/orders.ts";
    const head = `import express from "express";\napp.post("/orders", handler);\n`;
    const facts = factsFor(path, head);
    const changes: FileChange[] = [
      modified(path),
      modified("src/services/orderService.ts")
    ];

    const a = buildEvidenceGraph({ fileChanges: changes, baseFacts: [], headFacts: facts });
    const b = buildEvidenceGraph({
      fileChanges: [...changes].reverse(),
      baseFacts: [],
      headFacts: [...facts].reverse()
    });
    expect(a).toEqual(b);
  });

  it("never crashes on malformed or unknown facts", () => {
    const path = "src/db/schema.sql";
    const weird: AnalyzerFact[] = [
      { kind: "sql-table", value: {}, anchor: { path, startLine: 1, endLine: 1 } },
      {
        kind: "route",
        value: { receiver: "app" }, // missing method/path
        anchor: { path: "src/whatever.ts", startLine: 1, endLine: 1 }
      },
      {
        kind: "export",
        value: { declarationType: "function" }, // missing name
        anchor: { path: "orphan/not-in-diff.ts", startLine: 1, endLine: 1 }
      }
    ];
    const graph = buildEvidenceGraph({
      fileChanges: [modified(path)],
      baseFacts: [],
      headFacts: weird
    });
    expect(Array.isArray(graph.entities)).toBe(true);
    for (const entity of graph.entities) {
      expect(entity.provenance).toBe("derived");
    }
  });

  it("gives entities stable short ids derived from kind and technical label", () => {
    const path = "src/routes/orders.ts";
    const head = `app.post("/orders", handler);\n`;
    const graph = buildEvidenceGraph({
      fileChanges: [modified(path)],
      baseFacts: [],
      headFacts: factsFor(path, head)
    });
    const ids = graph.entities.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{12}$/);
    }
  });
});
