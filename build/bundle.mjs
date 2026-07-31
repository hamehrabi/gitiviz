#!/usr/bin/env node
/**
 * Bundles the gitiviz CLI into the committed, dependency-free plugin scripts:
 *
 *   packages/cli/src/main.ts            -> plugins/claude-code/scripts/analyze.mjs
 *   packages/cli/src/apply-narration.ts -> plugins/claude-code/scripts/apply-narration.mjs
 *
 * Run via `pnpm bundle` (inside ./dev.sh). The outputs are the distribution:
 * single ESM files whose only imports are node: builtins (ajv and the spec
 * JSON Schemas are embedded). After bundling, every import/require specifier
 * in each artifact is verified to be a node: builtin — the build fails
 * otherwise, so a dependency can never sneak into the committed scripts.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "plugins", "claude-code", "scripts");

const BANNER = `#!/usr/bin/env node
// GENERATED FILE — do not edit by hand.
// Bundled from packages/cli by build/bundle.mjs (pnpm bundle).
// Self-contained: the only imports are node: builtins.`;

const ENTRIES = [
  { entry: "packages/cli/src/main.ts", outfile: "analyze.mjs" },
  { entry: "packages/cli/src/apply-narration.ts", outfile: "apply-narration.mjs" }
];

/**
 * Every static import and require specifier in the bundle. esbuild with
 * platform=node keeps node builtins as real imports; anything else appearing
 * here means the bundle silently depends on the environment.
 */
function externalSpecifiers(source) {
  const specifiers = [];
  // Real ESM import statements. esbuild's unminified output puts each import
  // statement on its own line; ajv's embedded standalone-codegen *strings*
  // (e.g. `uri.code = 'require("ajv/...")'`) never match this shape.
  const importRe = /^import\b[^\n]*?["']([^"']+)["'];?\s*$/gm;
  // esbuild's shim for a require() it could not resolve/inline; its presence
  // with any specifier means the bundle depends on the environment.
  const shimRequireRe = /__require\(\s*["']([^"']+)["']\s*\)/g;
  // Dynamic import of a literal specifier.
  const dynamicImportRe = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  for (const re of [importRe, shimRequireRe, dynamicImportRe]) {
    for (const match of source.matchAll(re)) specifiers.push(match[1]);
  }
  return specifiers.filter((s) => !s.startsWith("node:"));
}

await mkdir(outDir, { recursive: true });

for (const { entry, outfile } of ENTRIES) {
  const outPath = join(outDir, outfile);
  await build({
    entryPoints: [join(repoRoot, entry)],
    outfile: outPath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    banner: { js: BANNER },
    logLevel: "warning"
  });

  const bundled = await readFile(outPath, "utf8");
  const offenders = externalSpecifiers(bundled);
  if (offenders.length > 0) {
    console.error(
      `bundle: ${outfile} imports non-builtin modules: ${[...new Set(offenders)].join(", ")}`
    );
    process.exit(1);
  }
  // Normalize: esbuild emits no trailing newline guarantee; keep POSIX text.
  if (!bundled.endsWith("\n")) await writeFile(outPath, `${bundled}\n`);
  console.log(`bundle: wrote ${outPath} (${bundled.length} bytes)`);
}
