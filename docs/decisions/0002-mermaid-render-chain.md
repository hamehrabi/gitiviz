# 0002 — Mermaid render chain (local → mermaid-cli via Docker → built-in fallback)

## Context

The book's concept diagrams are compiled to Mermaid text
(`packages/renderer/src/mermaid.ts`) and ideally prerendered to sanitized
inline SVG at build time (`mermaidSvg.ts`: real mermaid under jsdom,
deterministic, `securityLevel: "strict"`). But the committed plugin bundles
(`plugins/claude-code/scripts/*.mjs`) are dependency-free by decision 0001 —
they cannot ship `mermaid` or `jsdom`.

## Decision

One prerender chain, implemented in `packages/cli/src/mermaid-prerender.ts`
and honest at every step:

- **(a) Local toolchain.** `mermaid` + `jsdom` importable (the dev/Docker
  toolchain, where node_modules exist — both are workspace-root
  devDependencies so the bundle resolves them there too): render in-process
  through the renderer's deterministic pipeline. The bundles keep these as
  *fail-soft dynamic imports*; `build/bundle.mjs` verifies they are the only
  non-builtin specifiers and dynamic-import-only.
- **(b) mermaid-cli via Docker.** The CLI always writes each compiled source
  to `<out>/mermaid/<id>.mmd` plus the shared `mermaid-config.json`
  (`MERMAID_RENDER_CONFIG`: strict security, `htmlLabels: false`,
  deterministic ids — the same configuration as (a)).
  - (b1) A `<id>.svg` beside a byte-identical `<id>.mmd` is picked up and
    re-sanitized; stale SVGs are deleted.
  - (b2) When Docker is reachable from the CLI process, missing diagrams
    render through the official `minlag/mermaid-cli` image
    (`-I gitiviz-<id>` keeps DOM ids collision-free).
  The plugin launcher's Docker fallback cannot reach Docker from *inside*
  its container, so `run.sh` runs the (b2) pass host-side between exactly
  two CLI runs: analyze (writes `.mmd`, renders with fallback) →
  host mermaid-cli (writes `.svg`) → re-run (picks the SVGs up). Bounded,
  never recursive.
- **(c) Built-in engine.** Neither available: the deterministic built-in
  SVG engine renders with the honest caption "Rendered with the built-in
  diagram engine — Mermaid was unavailable at build time."

Every SVG that did not come from the in-process pipeline is sanitized with
the same policy before it touches the page: via jsdom when importable, else
the dependency-free `sanitizeMermaidSvgText` (`svgSanitizeLite.ts`) —
forbidden elements removed, `on*` handlers stripped, hrefs allowed only as
`#fragment` or `safeUrl`-validated against the repository origin, CSS
`url()` scrubbed, root normalized to `role="img"`.

Click-through links compile only when both the repository web origin
(`GITIVIZ_REPO_ORIGIN` env, else the `origin` remote translated to its
https form — `packages/cli/src/repo-origin.ts`) and a real head sha are
known; the compiler pins every link to `<origin>/blob/<sha>/<file>` and
rejects anything that leaves that origin.

## Consequences

- Real-mermaid output (clusters, tone classes, click links) in every
  environment that has either node_modules or Docker; never a hard failure
  without them, only the honest caption.
- The (b2) path renders in a real browser, so its SVG geometry is not
  byte-deterministic across machines (the (a) path remains so); sanitation
  and link policy are identical on both.
- `run.sh`'s Docker fallback runs the CLI twice when diagrams exist —
  the second pass only re-reads and re-renders, a few seconds.
