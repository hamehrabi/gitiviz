# Dashboard module contract (packages/renderer)

Contract for the three parallel agents building the dashboard reader
experience (docs/plans/2026-07-31-gitiviz-design.md, "Reader experience").
Stubs already typecheck; replace stub bodies, keep signatures EXACTLY.

## Hard rules (all modules)

- Pure string-building functions. No I/O, no Date/random — deterministic output.
- Zero JavaScript in output (CSP bans scripts). Light theme only.
- Every repo-derived string goes through `escape.ts` (`escHtml`/`escAttr`) at output.
- Provenance badges preserved: ◇ inferred / ✓ derived, glyph + title text
  (colour never the only carrier).
- Keyboard accessible; no horizontal page overflow at 320px; sidebar collapses
  to a scrollable top tab row under ~736px.
- Max ~8 visible elements per commit page before folds (`<details>`).
- All CSS lives in the module's exported `*Css` constant — the integrator
  concatenates them into the single `<style>`. Never emit `<style>` yourself.

## File ownership (no two agents touch the same file)

| File | Owner | Exports (signatures are frozen) |
| --- | --- | --- |
| `src/sidebar.ts` | Agent A | `renderSidebar(views: readonly ViewTab[], activeId: string, repoName?: string): string`; `sidebarCss: string` |
| `src/cards.ts` | Agent B | `renderFilterChips(types: readonly CommitType[]): string`; `renderCardsGrid(units: readonly CardModel[]): string`; `cardsCss: string` |
| `src/commitPage.ts` | Agent C | `renderCommitPage(unit: CommitPageModel, diagramSvg: string \| null): string`; `commitPageCss: string` |
| `src/dashboardTypes.ts` | FROZEN (architect) | `ViewTab`, `CardChip`, `CardModel`, `CommitPageModel`, `CARD_CHIP_LABELS`, `unitAnchorId(index)`, `toCardModel(unit, index, manifest)`, `toCommitPageModel(unit, index, manifest)` |
| `src/render.ts`, `src/index.ts` | INTEGRATOR only | shell assembly, CSS concatenation, wiring |

Agents may add sibling `*.test.ts` files for their own module only.

## CSS class naming convention

- `sb-` sidebar (agent A) - e.g. `sb-nav`, `sb-wordmark`, `sb-tabs`, `sb-tab`, `sb-item-active`
- `cd-` cards + filter chips (agent B) - e.g. `cd-filters`, `cd-chip`, `cd-grid`, `cd-card`, `cd-tag-<type>`
- `cp-` commit page (agent C) - e.g. `cp-page`, `cp-back-link`, `cp-beforeafter`, `cp-diagram`, `cp-evidence`

Never style outside your prefix. Shared primitives already exist in
render.ts (`prov` for ◇/✓ marks) — reuse the class, don't restyle it.

## The `:target` visibility mechanism (implemented by the INTEGRATOR)

- Each card is an `<a href="#u{index}">`; each commit page root carries
  `id="u{index}"` (`unitAnchorId(index)` — index = position in
  `manifest.changeUnits`). Real URL fragments, so browser Back works.
- Sidebar tabs target view sections the same way (`#home`, `#overview`, …);
  Home is the default when nothing is targeted.
- Integrator shell CSS: commit pages are `display:none` by default and
  `:target { display:block }`; the home grid hides when any commit page is
  targeted (structure to be chosen by integrator, e.g. sibling combinators
  from the targeted page). Modules must NOT ship their own show/hide rules —
  only guarantee the ids/hrefs above.
- Filter chips (agent B): radio inputs `name="cd-filter"`,
  ids `cd-filter-all` / `cd-filter-<type>`; show/hide of `cd-card`s via
  sibling selectors inside `cardsCss`. Inputs must remain focusable
  (visually hidden, not `display:none`) for keyboard access.

## Data flow

`ChangeManifest` → `toCardModel` / `toCommitPageModel` (dashboardTypes.ts,
the only manifest→view mapping point) → render functions. `diagramSvg`
comes from the existing diagram engine via the integrator; the
`renderCommitPage` parameter is the clean insertion point for a future
Mermaid export adapter. Verify with `./dev.sh "pnpm typecheck"` and
`./dev.sh "pnpm test"` (Docker only — never run node/pnpm on the host).
