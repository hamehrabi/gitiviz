/**
 * Guards the committed plugin bundles (plugins/claude-code/scripts/*.mjs):
 * they are the distribution, so they must be present, self-contained
 * (only node: builtin imports), carry the embedded spec schemas, carry a
 * WORKING Mermaid engine, and run from any working directory.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const scriptsDir = join(repoRoot, "plugins", "claude-code", "scripts");
const ARTIFACTS = ["analyze.mjs", "apply-narration.mjs"] as const;

/** The bundled Mermaid engine both CLI entry points share. */
const ENGINE = "mermaid-engine.mjs";
const ENGINE_SPECIFIER = `./${ENGINE}`;

/**
 * The only non-`node:` specifier a CLI bundle may name: the Mermaid engine
 * sibling we ship in the same directory, loaded lazily by relative path.
 * A plugin directory is copied to the user's machine whole, so the sibling
 * is always there; nothing is ever resolved through npm.
 */
const ALLOWED_DYNAMIC_IMPORTS = new Set([ENGINE_SPECIFIER]);

/**
 * Every executable import/require specifier in a bundle. Mirrors the check in
 * build/bundle.mjs: real ESM import statements sit on their own line in
 * esbuild's unminified output (ajv's embedded standalone-codegen *strings*
 * like `'require("ajv/dist/runtime/uri")'` never match that shape), and
 * `__require("x")` is esbuild's shim for a require it could not inline.
 */
function externalSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const importRe = /^import\b[^\n]*?["']([^"']+)["'];?\s*$/gm;
  const shimRequireRe = /__require\(\s*["']([^"']+)["']\s*\)/g;
  const dynamicImportRe = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  for (const re of [importRe, shimRequireRe]) {
    for (const match of source.matchAll(re)) specifiers.push(match[1]!);
  }
  for (const match of source.matchAll(dynamicImportRe)) {
    if (!ALLOWED_DYNAMIC_IMPORTS.has(match[1]!)) specifiers.push(match[1]!);
  }
  return specifiers.filter((s) => !s.startsWith("node:"));
}

async function run(
  artifact: string,
  args: string[]
): Promise<{ code: number; stderr: string }> {
  try {
    await execFileAsync(process.execPath, [join(scriptsDir, artifact), ...args], {
      cwd: tmpdir()
    });
    return { code: 0, stderr: "" };
  } catch (error) {
    const failed = error as { code?: number; stderr?: string };
    return { code: failed.code ?? -1, stderr: failed.stderr ?? "" };
  }
}

describe.each(ARTIFACTS)("plugins/claude-code/scripts/%s", (artifact) => {
  const source = readFileSync(join(scriptsDir, artifact), "utf8");

  it("is a committed, non-trivial generated file with a single shebang", () => {
    expect(source.length).toBeGreaterThan(10_000);
    expect(source.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(source).toContain("GENERATED FILE");
    // Exactly one shebang: a second one is a syntax error at runtime.
    expect(source.match(/^#!/gm)).toHaveLength(1);
  });

  it("imports nothing but node: builtins and the shipped engine sibling", () => {
    expect(externalSpecifiers(source)).toEqual([]);
  });

  it("loads the Mermaid engine lazily, by plugin-internal relative path", () => {
    // Present as a lazy probe…
    expect(source).toContain(`import("${ENGINE_SPECIFIER}")`);
    // …never as a hard static import (it is megabytes; it loads on demand).
    expect(source).not.toMatch(
      /^import\b[^\n]*?["']\.\/mermaid-engine\.mjs["'];?\s*$/m
    );
    // And never by npm name: an installed plugin has no node_modules.
    expect(source).not.toContain('import("jsdom")');
    expect(source).not.toContain('import("mermaid")');
    expect(source).not.toMatch(/^import\b[^\n]*?["'](?:jsdom|mermaid)["'];?\s*$/m);
  });

  it("embeds the spec JSON Schemas instead of reading them from disk", () => {
    expect(source).toContain("https://gitiviz.dev/spec/change-manifest.schema.json");
    expect(source).toContain("https://gitiviz.dev/spec/book-manifest.schema.json");
    expect(source).not.toMatch(/readFileSync\([^)]*spec\//);
  });
});

describe(`plugins/claude-code/scripts/${ENGINE}`, () => {
  const enginePath = join(scriptsDir, ENGINE);
  const source = readFileSync(enginePath, "utf8");

  it("is a committed, non-trivial generated file with a single shebang", () => {
    // Mermaid plus its DOM: megabytes, by construction.
    expect(source.length).toBeGreaterThan(1_000_000);
    expect(source.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(source).toContain("GENERATED FILE");
    expect(source.match(/^#!/gm)).toHaveLength(1);
  });

  it("declares no static import but node:module", () => {
    // The artifact is minified, so a text scan cannot tell an import from a
    // string inside vendored library data — the authoritative check is
    // esbuild's metafile in build/bundle.mjs, plus the render below, which
    // fails outright if anything is missing at runtime. What IS checkable
    // here: the only ESM import statement lives in the generated banner.
    const statements = [...source.matchAll(/^import\b[^\n]*?["']([^"']+)["'];?$/gm)];
    expect(statements.map((m) => m[1])).toEqual(["node:module"]);
  });

  /**
   * The real contract: Mermaid renders with NO node_modules anywhere above
   * the engine, no Docker, and no network. This is what an installed user's
   * machine looks like.
   */
  it("renders a clustered Mermaid flowchart from a node_modules-free directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gitiviz-engine-"));
    copyFileSync(enginePath, join(dir, ENGINE));
    const diagram = [
      "flowchart TD",
      "",
      'subgraph c0["Evidence Pipeline"]',
      '  n0["Git facts boundary<br/>controlled Git execution<br/>[exec.ts]"]',
      '  n1["Evidence graph<br/>core facts model<br/>[graph.ts]"]',
      "end",
      "",
      'subgraph c1["Interchange & Report"]',
      '  n2["Scriptless HTML renderer<br/>report generator<br/>[render.ts]"]',
      "end",
      "",
      'n0 -->|"resolves refs and diffs"| n1',
      'n1 -->|"validated book data"| n2',
      "",
      "classDef toneBlue fill:#dbeafe,stroke:#2563eb,stroke-width:1.5px,color:#172554",
      "class n0,n1,n2 toneBlue",
      ""
    ].join("\n");
    writeFileSync(
      join(dir, "probe.mjs"),
      [
        `import { loadMermaidRenderer } from "./${ENGINE}";`,
        `const renderer = await loadMermaidRenderer(${JSON.stringify({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          htmlLabels: false,
          deterministicIds: true,
          deterministicIDSeed: "gitiviz",
          flowchart: { htmlLabels: false }
        })});`,
        `const svg = await renderer.render("gitiviz-probe", ${JSON.stringify(diagram)});`,
        `process.stdout.write(svg);`
      ].join("\n")
    );
    const { stdout } = await execFileAsync(process.execPath, [join(dir, "probe.mjs")], {
      cwd: dir,
      maxBuffer: 32 * 1024 * 1024,
      // No npm resolution paths at all: nothing may be found outside `dir`.
      env: { ...process.env, NODE_PATH: "" }
    });

    // Mermaid's own markup signature — not our built-in engine's.
    expect(stdout).toContain('aria-roledescription="flowchart-v2"');
    expect(stdout.match(/<g class="cluster"/g)).toHaveLength(2);
    expect(stdout.match(/<g class="node /g)).toHaveLength(3);

    // Mermaid splits label text across per-word tspans; compare on the
    // rendered text, not the markup.
    const text = stdout
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"');
    // Both cluster titles, every node label line, every edge verb.
    for (const expected of [
      "Evidence Pipeline",
      "Interchange & Report",
      "Git facts boundary",
      "controlled Git execution",
      "[exec.ts]",
      "Scriptless HTML renderer",
      "[render.ts]",
      "resolves refs and diffs",
      "validated book data"
    ]) {
      expect(text).toContain(expected);
    }
    // Nothing was cut short.
    expect(text).not.toContain("…");
    // Labels are plain SVG text, never HTML in a foreignObject.
    expect(stdout).not.toMatch(/foreignobject/i);

    // Laid out, not stacked: every node sits at its own position and the
    // two edge labels are at different points (overlapping verbs were the
    // failure mode this whole change exists to remove).
    const nodePositions = [
      ...stdout.matchAll(/<g class="node [^>]*transform="translate\(([-\d.]+), ([-\d.]+)\)"/g)
    ].map((m) => `${m[1]},${m[2]}`);
    expect(new Set(nodePositions).size).toBe(3);
    const edgeLabelPositions = [
      ...stdout.matchAll(/<g class="edgeLabel" transform="translate\(([-\d.]+), ([-\d.]+)\)"/g)
    ].map((m) => `${m[1]},${m[2]}`);
    expect(edgeLabelPositions).toHaveLength(2);
    expect(new Set(edgeLabelPositions).size).toBe(2);
  }, 120_000);
});

describe("bundled artifacts run from an arbitrary directory", () => {
  it("analyze.mjs prints usage and exits 1 without arguments", async () => {
    const { code, stderr } = await run("analyze.mjs", []);
    expect(code).toBe(1);
    expect(stderr).toContain("Usage:");
    expect(stderr).toContain("gitiviz compare <base> <head>");
  });

  it("apply-narration.mjs runs the apply-narration command directly", async () => {
    const { code, stderr } = await run("apply-narration.mjs", [
      "--out",
      join(tmpdir(), "gitiviz-bundle-test-nonexistent")
    ]);
    expect(code).toBe(1);
    // Reaching this message proves module load succeeded (Ajv compiled the
    // embedded schemas) and the command was dispatched as apply-narration.
    expect(stderr).toContain("manifests/change.json not found");
  });
});
