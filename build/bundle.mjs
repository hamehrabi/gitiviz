#!/usr/bin/env node
/**
 * Bundles the gitiviz CLI into the committed, dependency-free plugin scripts:
 *
 *   packages/cli/src/main.ts               -> plugins/claude-code/scripts/analyze.mjs
 *   packages/cli/src/apply-narration.ts    -> plugins/claude-code/scripts/apply-narration.mjs
 *   packages/renderer/src/mermaidEngine.ts -> plugins/claude-code/scripts/mermaid-engine.mjs
 *
 * Run via `pnpm bundle` (inside ./dev.sh). The outputs are the distribution.
 *
 * The third artifact is the point of this build: it carries REAL Mermaid
 * (plus the DOM it needs) inside the plugin, so an installed user renders
 * proper Mermaid diagrams on any machine — offline, no Docker, no npm
 * install, nothing to download. It is emitted ONCE and shared: both CLI
 * entry points load it lazily by RELATIVE path (`./mermaid-engine.mjs`),
 * which is safe because a plugin directory is copied to the user's machine
 * whole. Emitting it twice would double several megabytes for no reason.
 *
 * The dependency contract is unchanged and still verified here: after
 * bundling, every import/require specifier in every artifact must be a
 * `node:` builtin — with the single, explicitly whitelisted exception of
 * the plugin-internal `./mermaid-engine.mjs` sibling. Anything else fails
 * the build, so a hard npm dependency can never sneak into the committed
 * scripts.
 *
 * Two mechanical details make the engine bundle possible:
 *   - Bare builtin specifiers (`require("fs")`) are aliased to their
 *     `node:` form, so the artifact names its builtins the same way
 *     everywhere and the guard stays a simple prefix check.
 *   - jsdom probes a handful of OPTIONAL native add-ons (`canvas`,
 *     `bufferutil`, …) inside try/catch. Those are aliased to an empty
 *     stub: the probes then resolve to `{}` at build time instead of
 *     leaving unresolvable runtime requires behind. None of them affect
 *     diagram rendering — jsdom's own fallbacks are what we already use.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "plugins", "claude-code", "scripts");

const BANNER = `#!/usr/bin/env node
// GENERATED FILE — do not edit by hand.
// Bundled from packages/cli by build/bundle.mjs (pnpm bundle).
// Self-contained: the only imports are node: builtins.`;

/**
 * The shared Mermaid engine artifact. The renderer imports it by module
 * specifier (packages/renderer/src/mermaidEngine.ts); in the bundle that
 * specifier is rewritten to this sibling file and kept external.
 */
const ENGINE_SOURCE = "packages/renderer/src/mermaidEngine.ts";
const ENGINE_OUTFILE = "mermaid-engine.mjs";
const ENGINE_SPECIFIER = `./${ENGINE_OUTFILE}`;

const ENGINE_BANNER = `#!/usr/bin/env node
// GENERATED FILE — do not edit by hand.
// Bundled from packages/renderer/src/mermaidEngine.ts by build/bundle.mjs.
// Carries Mermaid and its DOM so diagrams render with no install and no
// network. Self-contained: the only imports are node: builtins.
import { createRequire as __gitivizCreateRequire } from "node:module";
const __gitivizRequire = __gitivizCreateRequire(import.meta.url);
// Bundled CommonJS asks for its builtins through this shim. \`resolve\` is
// tolerant on purpose: jsdom resolves an optional sync-XHR worker file at
// module load that this single-file bundle does not ship, and a hard throw
// there would take the whole engine down for a feature no diagram uses.
const require = Object.assign((id) => __gitivizRequire(id), {
  resolve: (id) => {
    try {
      return __gitivizRequire.resolve(id);
    } catch {
      return null;
    }
  },
  cache: __gitivizRequire.cache,
  main: undefined
});`;

const ENTRIES = [
  { entry: "packages/cli/src/main.ts", outfile: "analyze.mjs" },
  { entry: "packages/cli/src/apply-narration.ts", outfile: "apply-narration.mjs" }
];

/**
 * Optional native add-ons jsdom (and its transitive deps) probe inside
 * try/catch. Stubbing them keeps the bundle resolvable and changes no
 * behaviour we rely on: jsdom already runs without them.
 */
const OPTIONAL_NATIVE_MODULES = [
  "canvas",
  "bufferutil",
  "utf-8-validate",
  "supports-color"
];

/** Bare builtin specifiers -> their `node:` form, plus the stubs above. */
function bundleAliases(stubPath) {
  const alias = {};
  for (const name of builtinModules) {
    if (name.startsWith("node:") || name.startsWith("_")) continue;
    alias[name] = `node:${name}`;
  }
  for (const name of OPTIONAL_NATIVE_MODULES) alias[name] = stubPath;
  return alias;
}

/**
 * Rewrites the renderer's engine import to the sibling artifact and marks
 * it external, so the heavy engine is emitted once instead of inlined into
 * every entry point.
 */
const engineExternalPlugin = {
  name: "gitiviz-engine-external",
  setup(build) {
    build.onResolve({ filter: /mermaidEngine\.(js|ts)$/ }, () => ({
      path: ENGINE_SPECIFIER,
      external: true
    }));
  }
};

/**
 * Every static import and require specifier in the bundle. esbuild with
 * platform=node keeps node builtins as real imports; anything else appearing
 * here means the bundle silently depends on the environment.
 */
function externalSpecifiers(source, allowedDynamic) {
  const specifiers = [];
  // Real ESM import statements. esbuild's unminified output puts each import
  // statement on its own line; ajv's embedded standalone-codegen *strings*
  // (e.g. `uri.code = 'require("ajv/...")'`) never match this shape.
  const importRe = /^import\b[^\n]*?["']([^"']+)["'];?\s*$/gm;
  // esbuild's shim for a require() it could not resolve/inline; its presence
  // with any specifier means the bundle depends on the environment.
  const shimRequireRe = /__require\(\s*["']([^"']+)["']\s*\)/g;
  // Dynamic import of a literal specifier: hard dependency unless the
  // specifier is a plugin-internal sibling we ship ourselves.
  const dynamicImportRe = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  for (const re of [importRe, shimRequireRe]) {
    for (const match of source.matchAll(re)) specifiers.push(match[1]);
  }
  for (const match of source.matchAll(dynamicImportRe)) {
    if (!allowedDynamic.has(match[1])) specifiers.push(match[1]);
  }
  return specifiers.filter((s) => !s.startsWith("node:"));
}

/**
 * esbuild's own record of what it left unresolved. This is the AUTHORITATIVE
 * check: it sees every import/require esbuild could not inline, whatever the
 * output looks like. The textual scan below is a second opinion that only
 * works on unminified output (in minified code an `import(` or a `from"…"`
 * can just as easily be a string literal inside vendored library data).
 */
function metafileExternals(metafile) {
  const externals = [];
  for (const output of Object.values(metafile.outputs)) {
    for (const imported of output.imports ?? []) {
      if (imported.external === true) externals.push(imported.path);
    }
  }
  return externals;
}

function fail(outfile, offenders) {
  console.error(
    `bundle: ${outfile} imports non-builtin modules: ${[...new Set(offenders)].join(", ")}`
  );
  process.exit(1);
}

async function verify(outPath, outfile, allowed, metafile, { scanText }) {
  const externals = metafileExternals(metafile).filter(
    (spec) => !spec.startsWith("node:") && !allowed.has(spec)
  );
  if (externals.length > 0) fail(outfile, externals);

  const bundled = await readFile(outPath, "utf8");
  if (scanText) {
    const offenders = externalSpecifiers(bundled, allowed);
    if (offenders.length > 0) fail(outfile, offenders);
  }
  // Normalize: esbuild emits no trailing newline guarantee; keep POSIX text.
  if (!bundled.endsWith("\n")) await writeFile(outPath, `${bundled}\n`);
  console.log(`bundle: wrote ${outPath} (${bundled.length} bytes)`);
}

await mkdir(outDir, { recursive: true });

// --- 1. the shared Mermaid engine -------------------------------------------

const stubPath = join(repoRoot, "build", "optional-native-stub.cjs");
const enginePath = join(outDir, ENGINE_OUTFILE);
const engineBuild = await build({
  entryPoints: [join(repoRoot, ENGINE_SOURCE)],
  outfile: enginePath,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  alias: bundleAliases(stubPath),
  banner: { js: ENGINE_BANNER },
  // Minified for size: this artifact is several megabytes of vendored
  // library code that nobody reads or diffs by hand. Unminified it is
  // roughly three times larger for zero benefit.
  minify: true,
  legalComments: "none",
  metafile: true,
  logLevel: "warning"
});
await verify(enginePath, ENGINE_OUTFILE, new Set(), engineBuild.metafile, {
  scanText: false
});

// --- 2. the CLI entry points ------------------------------------------------

for (const { entry, outfile } of ENTRIES) {
  const outPath = join(outDir, outfile);
  const result = await build({
    entryPoints: [join(repoRoot, entry)],
    outfile: outPath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    plugins: [engineExternalPlugin],
    banner: { js: BANNER },
    metafile: true,
    logLevel: "warning"
  });
  await verify(outPath, outfile, new Set([ENGINE_SPECIFIER]), result.metafile, {
    scanText: true
  });
}
