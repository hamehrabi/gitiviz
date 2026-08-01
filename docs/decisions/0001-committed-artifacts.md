# ADR 0001: Committed plugin bundles; generated books never committed

**Date:** 2026-07-31
**Status:** Accepted

## Context

Gitiviz ships as a Claude Code plugin. When a user runs
`/plugin marketplace add hamehrabi/gitiviz`, Claude Code clones this repository
and the slash commands execute scripts out of `plugins/claude-code/scripts/`
directly. There is no install step: no `npm install`, no build hook, no
registry. Whatever is in the repo is what runs on the user's machine.

The engine itself is a pnpm workspace (`packages/*`) with real dependencies
(ajv for schema validation, esbuild for building). Users must not need any of
that; contributors must not even need Node on the host (all toolchain runs in
Docker via `./dev.sh`).

Separately, running gitiviz produces per-repo output under `.gitiviz/`
(manifests, narration request/response, `dist/index.html`).

## Decision

1. **The bundled artifacts in `plugins/claude-code/scripts/` are committed.**
   `build/bundle.mjs` (run as `pnpm bundle` inside `./dev.sh`) compiles
   `packages/cli` into single-file ESM bundles (`analyze.mjs`,
   `apply-narration.mjs`) whose only imports are `node:` builtins. The spec
   JSON Schemas and ajv are embedded in the bundle, so the files work from any
   location on disk. The bundler fails the build if any non-builtin specifier
   survives, so a runtime dependency can never sneak into the committed
   scripts.

2. **Generated output under `.gitiviz/` is never committed — except the
   narration.** Manifests, `narration-request.json`, `mermaid/`, `issues.json`
   and `dist/` are derived per-comparison data and stay ignored. But
   `.gitiviz/narration-response.json` **is committed**: it is curated work
   product (project summary, chapter text, per-commit stories, and the
   architecture diagram spec), not a derivation. Without it a fresh clone
   renders a *different book* — the code is identical, but each machine's
   agent writes its own prose and its own diagram. Committing it makes the
   book reproducible and reviewable, and lets narration improvements land
   through pull requests like any other content.

   *(Amended 2026-08-02 after observing exactly this: the same commit rendered
   different architecture diagrams on two machines.)*

3. **CI enforces bundle freshness.** The workflow reruns `pnpm bundle` and
   fails on `git diff --exit-code plugins/`, so a change to `packages/`
   cannot land with stale committed bundles.

## Consequences

- Installing the plugin is a git clone — instant, offline-capable, and free of
  supply-chain surprises at install time (the code that runs is the code that
  was reviewed in the repo).
- Bundle diffs appear in PRs. They are generated noise for review purposes,
  but they are also the actual shipped artifact, so having them in history is
  a feature: `git log plugins/` shows exactly what users ran when.
- Contributors must remember `./dev.sh "pnpm bundle"` after changing
  `packages/`; CI turns forgetting into a hard failure rather than a silent
  drift between source and artifact.
- The bundles are only regenerated through the pinned Docker toolchain, which
  keeps them reproducible across contributor machines.

## Alternatives considered

- **Publish to npm and install on plugin load** — rejected: adds a network
  install step, a registry trust dependency, and version skew between plugin
  and package; npm publication is deferred to a later standalone-CLI release.
- **Build on the user's machine at first run** — rejected: requires the full
  toolchain (pnpm, esbuild) on user machines and violates the
  "dependency-free scripts" contract of the plugin.
- **Committing `.gitiviz/` sample output for demos** — rejected: it goes
  stale immediately and the template edition can be regenerated in seconds
  from the launcher.
