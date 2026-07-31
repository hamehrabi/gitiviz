/**
 * Guards the committed plugin bundles (plugins/claude-code/scripts/*.mjs):
 * they are the distribution, so they must be present, self-contained
 * (only node: builtin imports), carry the embedded spec schemas, and run
 * from any working directory.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const scriptsDir = join(repoRoot, "plugins", "claude-code", "scripts");
const ARTIFACTS = ["analyze.mjs", "apply-narration.mjs"] as const;

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
  for (const re of [importRe, shimRequireRe, dynamicImportRe]) {
    for (const match of source.matchAll(re)) specifiers.push(match[1]!);
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

  it("imports nothing but node: builtins (deps are bundled in)", () => {
    expect(externalSpecifiers(source)).toEqual([]);
  });

  it("embeds the spec JSON Schemas instead of reading them from disk", () => {
    expect(source).toContain("https://gitiviz.dev/spec/change-manifest.schema.json");
    expect(source).toContain("https://gitiviz.dev/spec/book-manifest.schema.json");
    expect(source).not.toMatch(/readFileSync\([^)]*spec\//);
  });
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
