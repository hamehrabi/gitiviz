# 0002 — Mermaid render chain (bundled Mermaid → mermaid-cli via Docker → built-in fallback)

## Context

The book's concept diagrams are compiled to Mermaid text
(`packages/renderer/src/mermaid.ts`) and prerendered to sanitized inline SVG
at build time (`mermaidSvg.ts`: real mermaid over a real DOM, deterministic,
`securityLevel: "strict"`).

Originally `mermaid` and `jsdom` were devDependencies, so only a checkout of
this repo could render them. Everyone who installed the plugin from GitHub —
no `node_modules` — fell straight through to Docker, and without Docker to
the built-in engine. In practice that meant most users never saw a real
diagram. Unacceptable: the diagrams are the product.

## Decision

**Ship Mermaid inside the plugin.** `build/bundle.mjs` emits a third
committed artifact, `plugins/claude-code/scripts/mermaid-engine.mjs`, which
inlines real Mermaid plus the DOM it runs on
(`packages/renderer/src/mermaidEngine.ts` is its only entry point). Both CLI
bundles load it lazily by RELATIVE path — a plugin directory is copied to
the user's machine whole, so the sibling is always there and nothing is ever
resolved through npm.

The chain in `packages/cli/src/mermaid-prerender.ts` keeps its shape, but
link (a) now succeeds everywhere instead of only in this repo:

- **(a) Bundled Mermaid engine — the default.** Real Mermaid, in-process,
  deterministic, offline, no Docker, no install, nothing to download. This
  is what an installed user gets.
- **(b) mermaid-cli via Docker — secondary.** Kept for the case where the
  engine cannot load at all, and because the CLI already writes each
  compiled source to `<out>/mermaid/<id>.mmd` plus the shared
  `mermaid-config.json` (`MERMAID_RENDER_CONFIG`: strict security,
  `htmlLabels: false`, deterministic ids — the same configuration as (a)).
  - (b1) A `<id>.svg` beside a byte-identical `<id>.mmd` is picked up and
    re-sanitized; stale SVGs are deleted.
  - (b2) When Docker is reachable from the CLI process, missing diagrams
    render through the official `minlag/mermaid-cli` image
    (`-I gitiviz-<id>` keeps DOM ids collision-free).
  The plugin launcher's Docker fallback cannot reach Docker from *inside*
  its container, so `run.sh` runs the (b2) pass host-side between exactly
  two CLI runs: analyze (writes `.mmd`) → host mermaid-cli (writes `.svg`)
  → re-run (picks the SVGs up). Bounded, never recursive.
- **(c) Built-in engine — genuine last resort.** If even the bundled engine
  fails to load, the deterministic built-in SVG engine renders with the
  honest caption "Rendered with the built-in diagram engine — the bundled
  Mermaid engine could not load here." Users should never see this.

### How the engine bundles cleanly

The dependency contract from decision 0001 is unchanged: every artifact in
`plugins/claude-code/scripts/` imports nothing but `node:` builtins, with
the single whitelisted exception of the plugin-internal
`./mermaid-engine.mjs` sibling. Three mechanics make that true of a bundle
that contains a whole DOM implementation:

- Bare builtin specifiers (`require("fs")`) are aliased to their `node:`
  form, so the artifact names its builtins one way and the guard stays a
  simple prefix check.
- The optional native add-ons jsdom probes inside `try`/`catch` (`canvas`,
  `bufferutil`, `utf-8-validate`, `supports-color`) are aliased to an empty
  stub. None of them participate in diagram rendering.
- A generated banner supplies `require` via `createRequire(import.meta.url)`
  for the bundled CommonJS, with a tolerant `require.resolve` (jsdom
  resolves an optional sync-XHR worker file at load time that a single-file
  bundle does not ship; a hard throw there would take the engine down for a
  feature no diagram uses).

Verification is by esbuild's **metafile**, not by scanning text: the engine
is minified, and in minified vendor code an `import(` or `from"…"` can just
as easily be a string literal. The metafile lists every specifier esbuild
could not inline, which is exactly the question being asked. On top of that,
`tests/bundle.test.ts` copies the committed engine to a temporary directory
with no `node_modules` anywhere above it and renders a clustered flowchart
there — the only proof that actually matters. `build/e2e-clean-machine.sh`
goes further and reproduces a whole end-user run (fixture repo, committed
artifacts only, Docker unreachable) inside the dev container.

Sanitation is unchanged. Every SVG is sanitized with the same policy before
it touches the page: via the bundled DOM when it loads, else the
dependency-free `sanitizeMermaidSvgText` (`svgSanitizeLite.ts`) — forbidden
elements removed, `on*` handlers stripped, hrefs allowed only as
`#fragment` or `safeUrl`-validated against the repository origin, CSS
`url()` scrubbed, root normalized to `role="img"`.

Click-through links compile only when both the repository web origin
(`GITIVIZ_REPO_ORIGIN` env, else the `origin` remote translated to its
https form — `packages/cli/src/repo-origin.ts`) and a real head sha are
known; the compiler pins every link to `<origin>/blob/<sha>/<file>` and
rejects anything that leaves that origin.

## Consequences

- Real-mermaid output (clusters, tone classes, wrapped labels, routed
  verb-labelled edges, click links) on every machine, offline, with no
  Docker and no downloads. Docker is now optional polish, not a
  requirement.
- The committed plugin grows by the size of the engine artifact (~6.8 MB
  minified, emitted ONCE and shared by both CLI entry points rather than
  duplicated). The CLI bundles themselves got slightly smaller.
- The engine is loaded lazily, so commands that render no diagrams never
  pay for parsing it.
- The (b2) path renders in a real browser, so its SVG geometry is not
  byte-deterministic across machines (the (a) path remains so); sanitation
  and link policy are identical on both.
