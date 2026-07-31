import { describe, it, expect } from "vitest";
import { packageAnalyzer } from "./packageAnalyzer.js";

const VALID = `{
  "name": "demo-app",
  "version": "1.0.0",
  "dependencies": {
    "express": "^4.18.0",
    "pg": "8.11.0"
  },
  "devDependencies": {
    "vitest": "^2.0.0"
  }
}
`;

describe("packageAnalyzer.appliesTo", () => {
  it("matches package.json at repo root and in subdirectories", () => {
    expect(packageAnalyzer.appliesTo("package.json")).toBe(true);
    expect(packageAnalyzer.appliesTo("packages/api/package.json")).toBe(true);
  });

  it("does not match other files", () => {
    expect(packageAnalyzer.appliesTo("src/index.ts")).toBe(false);
    expect(packageAnalyzer.appliesTo("notpackage.json")).toBe(false);
    expect(packageAnalyzer.appliesTo("package.json.bak")).toBe(false);
    expect(packageAnalyzer.appliesTo("package-lock.json")).toBe(false);
  });
});

describe("packageAnalyzer.analyze", () => {
  it("has a versioned id for cache keys", () => {
    expect(packageAnalyzer.id).toBe("js-package@1");
  });

  it("emits a package name fact", () => {
    const result = packageAnalyzer.analyze({ path: "package.json", content: VALID });
    const nameFacts = result.facts.filter((f) => f.value.role === "name");
    expect(nameFacts).toHaveLength(1);
    expect(nameFacts[0]!.kind).toBe("package");
    expect(nameFacts[0]!.value.name).toBe("demo-app");
    expect(result.limitations).toHaveLength(0);
  });

  it("anchors the name fact to the line declaring it", () => {
    const result = packageAnalyzer.analyze({ path: "package.json", content: VALID });
    const nameFact = result.facts.find((f) => f.value.role === "name")!;
    expect(nameFact.anchor.path).toBe("package.json");
    expect(nameFact.anchor.startLine).toBe(2);
    expect(nameFact.anchor.endLine).toBe(2);
  });

  it("emits one dependency fact per entry with its section", () => {
    const result = packageAnalyzer.analyze({ path: "package.json", content: VALID });
    const deps = result.facts.filter((f) => f.value.role === "dependency");
    expect(deps.map((f) => f.value.name).sort()).toEqual(["express", "pg", "vitest"]);
    const express = deps.find((f) => f.value.name === "express")!;
    expect(express.value.version).toBe("^4.18.0");
    expect(express.value.section).toBe("dependencies");
    expect(express.anchor.startLine).toBe(5);
    const vitest = deps.find((f) => f.value.name === "vitest")!;
    expect(vitest.value.section).toBe("devDependencies");
  });

  it("never crashes on malformed JSON — records a limitation instead", () => {
    const result = packageAnalyzer.analyze({
      path: "pkg/package.json",
      content: "{ not json !!!"
    });
    expect(result.facts).toHaveLength(0);
    expect(result.limitations).toHaveLength(1);
    expect(result.limitations[0]!.path).toBe("pkg/package.json");
    expect(result.limitations[0]!.analyzer).toBe("js-package@1");
    expect(result.limitations[0]!.message).toMatch(/parse/i);
  });

  it("records a limitation when the root is not an object", () => {
    const result = packageAnalyzer.analyze({ path: "package.json", content: "[1, 2, 3]" });
    expect(result.facts).toHaveLength(0);
    expect(result.limitations).toHaveLength(1);
  });

  it("skips non-string fields as data problems, not crashes", () => {
    const content = JSON.stringify({
      name: 42,
      dependencies: { good: "^1.0.0", bad: { nested: true } }
    });
    const result = packageAnalyzer.analyze({ path: "package.json", content });
    const deps = result.facts.filter((f) => f.value.role === "dependency");
    expect(deps.map((f) => f.value.name)).toEqual(["good"]);
    expect(result.facts.some((f) => f.value.role === "name")).toBe(false);
  });

  it("passes hostile strings through as inert data", () => {
    const hostileName = '<img src=x onerror=alert(1)>';
    const content = JSON.stringify({
      name: hostileName,
      dependencies: { '"><script>alert(1)</script>': "javascript:alert(1)" }
    });
    const result = packageAnalyzer.analyze({ path: "package.json", content });
    const nameFact = result.facts.find((f) => f.value.role === "name")!;
    expect(nameFact.value.name).toBe(hostileName);
    const dep = result.facts.find((f) => f.value.role === "dependency")!;
    expect(dep.value.name).toBe('"><script>alert(1)</script>');
    expect(dep.value.version).toBe("javascript:alert(1)");
  });

  it("survives a single enormous line without pathological behavior", () => {
    const huge = JSON.stringify({ name: "big", description: "x".repeat(500_000) });
    const result = packageAnalyzer.analyze({ path: "package.json", content: huge });
    expect(result.facts.find((f) => f.value.role === "name")!.value.name).toBe("big");
  });

  it("anchors fall back to the whole file when a key line cannot be located", () => {
    // Name key split across an escape-heavy document still parses; the line
    // locator may not find it — the anchor must still be valid.
    const content = '{"nam\\u0065": "escaped-name"}';
    const result = packageAnalyzer.analyze({ path: "package.json", content });
    const nameFact = result.facts.find((f) => f.value.role === "name");
    expect(nameFact).toBeDefined();
    expect(nameFact!.anchor.startLine).toBeGreaterThanOrEqual(1);
    expect(nameFact!.anchor.endLine).toBeGreaterThanOrEqual(nameFact!.anchor.startLine);
  });
});
