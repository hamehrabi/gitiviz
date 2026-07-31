# Gitiviz

Turn any Git branch, commit, or range into a plain-language, evidence-backed,
self-contained HTML change book.

AI coding agents produce changed lines faster than humans can review them.
Gitiviz is the comprehension layer: a deterministic facts engine reads your
Git history, your coding agent narrates the facts in plain language, and a
validator rejects any claim that is not anchored to real evidence. The result
is one offline HTML file a PM can read top-to-bottom — with the developer
evidence collapsed underneath every statement.

- Deterministic facts are labelled **✓ derived**; agent narration is labelled
  **◇ AI interpretation**. The provenance is structural — it cannot be faked
  by the narrator.
- The output is a single scriptless HTML file (strict CSP, no JavaScript, no
  network). Open it from disk, attach it to a ticket, email it.
- No PR, no remote, no backend required. Everything runs locally against
  `.git`.

## Install (Claude Code plugin)

```
/plugin marketplace add hamehrabi/gitiviz
/plugin install gitiviz@gitiviz
```

The plugin's analysis scripts are committed, dependency-free Node bundles —
installing the plugin never runs `npm install`. They need Node.js 20+ on your
machine, or Docker as a fallback (the launcher picks whichever is available).

### Commands

| Command | What it does |
| --- | --- |
| `/gitiviz:branch [base]` | Explain what the current branch changed vs a base (default: the repo's main branch) |
| `/gitiviz:commit <sha>` | Explain one commit vs its parent |
| `/gitiviz:compare <base> <head>` | Explain an arbitrary range — branch names, SHAs, `HEAD~3`, anything `git rev-parse` accepts |
| `/gitiviz:open` | Open the generated HTML book |

Each command runs the deterministic engine, has Claude write narration through
the validated narration API, and opens `.gitiviz/dist/index.html`.

## Demo walkthrough

From inside any TypeScript/JavaScript repository with a feature branch:

1. In Claude Code, run:

   ```
   /gitiviz:compare main feature/my-branch
   ```

2. The bundled engine (no AI) resolves the range, walks the diff, and runs the
   analyzers (packages/workspaces, imports & exported symbols, HTTP routes).
   Every fact gets an evidence anchor — file path, blob hash, line range. It
   writes:

   ```
   .gitiviz/manifests/…              schema-validated fact manifests
   .gitiviz/narration-request.json   facts-only payload for the narrator
   .gitiviz/dist/index.html          the book, template edition (facts only)
   ```

3. Claude reads `narration-request.json` and writes plain-language titles,
   before/after descriptions, and impact statements to
   `narration-response.json`. The validator rejects any sentence that
   references an entity or change unit not present in the facts.

4. The book re-renders with narration merged in and opens in your browser:
   a chapter per semantic change unit, a C4-style diagram of the affected
   systems, a commit timeline (fixup/formatting noise kept out of the
   chapters), and the ten-chapter book skeleton — in v0.1, seven chapters
   honestly render as "not yet written".

No agent handy? The engine works standalone — from your repo:

```sh
path/to/gitiviz/plugins/claude-code/scripts/run.sh compare main feature/my-branch
open .gitiviz/dist/index.html
```

You get the template edition: every fact, no prose.

## Local development

The host machine needs only **git and Docker** — no Node, npm, or pnpm. All
toolchain runs inside a pinned container via `./dev.sh`:

```sh
./dev.sh "pnpm install"                  # once
./dev.sh "pnpm typecheck && pnpm test"   # full suite
./dev.sh "pnpm bundle"                   # rebuild committed plugin bundles
```

CI (`.github/workflows/ci.yml`) runs the same commands in the same
`node:22-bookworm` image and fails if `pnpm bundle` produces a diff in
`plugins/` — the committed bundles must never go stale (see
[docs/decisions/0001-committed-artifacts.md](docs/decisions/0001-committed-artifacts.md)).

### Repository layout

```
packages/schema        JSON Schemas + TS types (BookManifest, ChangeManifest, …)
packages/git           ref resolution, merge-base, diffs — never shells repo strings
packages/analyzers     TS/JS analyzers: packages, imports/exports, HTTP routes
packages/core          evidence graph, change units, narration validation
packages/renderer      scriptless single-file HTML book + inline SVG diagrams
packages/cli           command dispatch; bundled into the plugin scripts
plugins/claude-code    the shipped plugin: launcher + committed bundles
commands/              /gitiviz:* slash commands
spec/                  versioned JSON Schemas
```

## Security posture

Repository content is hostile input. Everything from the repo — paths, commit
messages, symbols, file contents — is HTML-escaped in the book and treated
strictly as data in the narration loop; the generated HTML contains no scripts
and carries a CSP that refuses them. The test suite includes a hostile-repo
sweep asserting exactly this.

## License

MIT — see [LICENSE](LICENSE).
