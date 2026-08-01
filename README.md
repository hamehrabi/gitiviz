# Gitiviz

**Understand what changed in your code — without reading any code.**

Gitiviz reads your project's history and writes you a small website that
explains it in plain English: what each change did, why it matters, and a
simple picture of the parts involved. Non-technical people can read it. It
works offline. It's one file you can email to anyone.

It's built for the age of AI coding assistants: they write changes faster
than anyone can review them, so Gitiviz turns every change into a short,
honest story.

**Honest by design.** Facts pulled straight from your project are marked
**✓**. Sentences written by the AI are marked **◇**. The AI is never allowed
to claim something the code doesn't actually show.

---

## Get started in 2 minutes

### Step 1 — Check you have what's needed

You need [Claude Code](https://claude.com/claude-code), and on your computer:

- **Git** (you already have it if you use GitHub), and
- **either** Node.js 20+ **or** Docker — whichever you have. You don't need
  both, and you don't need to configure anything.

Nothing gets downloaded or installed into your project. Gitiviz ships ready to
run.

### Step 2 — Install the plugin

Open Claude Code and type these two lines, one at a time:

```
/plugin marketplace add hamehrabi/gitiviz
```

```
/plugin install gitiviz@gitiviz
```

The first line tells Claude Code where to find Gitiviz. The second installs it.
(The name appears twice because it's `plugin-name@catalog-name` — both are
called "gitiviz".)

That's it — you install once, and it works in **all** your projects from then
on. If the commands don't show up right away, restart Claude Code.

### Step 3 — Use it on any project

Open Claude Code inside any project folder and type:

```
/gitiviz:init
```

Claude will look through your recent history, understand what your project
does, write the explanations, and build the book. It takes a few seconds.

When it finishes, open the file it made:

```
.gitiviz/dist/index.html
```

Double-click it, or ask Claude: `/gitiviz:open`

### Step 4 — Read it

- **Home** — every change as a card. Click any card to read its story.
- **Overview** — what this project is, in a paragraph.
- **Architecture** — a map of the pieces and how they connect.
- **How it works** — how to install and use the project.
- **Issues** — tickets you've raised from the book.

On a change's page you'll find: what it does in plain words, a *before* and
*after*, a simple diagram, and — folded away at the bottom for developers —
the exact files that changed, linked to GitHub.

### Step 5 — It keeps itself up to date

After that first `/gitiviz:init`, you don't have to do anything. Every time
Claude Code makes a commit in that project, Gitiviz automatically writes the
story for it and adds it to the book.

(In projects where you never ran `/gitiviz:init`, nothing happens at all.)

---

## Everyday commands

Type these in Claude Code, inside your project:

| Type this | And you get |
| --- | --- |
| `/gitiviz:init` | The full book for your project — **start here** |
| `/gitiviz:open` | Opens the book in your browser |
| `/gitiviz:branch` | Explains what your current branch changed |
| `/gitiviz:commit <id>` | Explains one specific change |
| `/gitiviz:compare main my-branch` | Explains the difference between any two points |
| `/gitiviz:discuss <id>` | Ask Claude questions about a change — it answers from the real code |
| `/gitiviz:ticket <id> "Title"` | Turns a change into a GitHub issue, which then appears in the Issues tab |

`<id>` is the short code shown on each change's card (like `a4e462c`).

## Good to know

**Add `.gitiviz/` to your project's `.gitignore`.** The book is generated
output — it can be rebuilt any time, so there's no need to store it in Git.

**Nothing leaves your computer** unless you ask for a ticket. The book is
built from your local history, contains no code that runs, and works with
your internet off.

**Sharing it:** the book is a single file. Email it, attach it to a ticket,
or drop it in Slack — it opens in any browser, on any machine.

---

## For engineers

The rest of this README covers the internals: the fact/narration split, the
validation guarantees, the security posture, and how to develop on Gitiviz
itself.

Gitiviz is a deterministic facts engine plus a validated narration loop. The
engine reads Git and the source tree and emits schema-validated fact
manifests; your coding agent narrates those facts; a validator rejects any
claim or diagram anchor that is not backed by real evidence. Provenance is
structural — `derived` cannot be claimed by a narrator.

- The output is a single scriptless HTML file (strict CSP, no JavaScript, no
  network). Open it from disk, attach it to a ticket, email it.
- No PR, no remote, no backend required. Everything runs locally against
  `.git`.
- The plugin's analysis scripts are committed, dependency-free Node bundles —
  installing the plugin never runs `npm install`. They need Node.js 20+, or
  Docker as a fallback (the launcher picks whichever is available).

### Commands

| Command | What it does |
| --- | --- |
| `/gitiviz:init [--commits N]` | Bootstrap the project story book from the last 20 commits (or N) |
| `/gitiviz:branch [base]` | Explain what the current branch changed vs a base (default: the repo's main branch) |
| `/gitiviz:commit <sha>` | Explain one commit vs its parent |
| `/gitiviz:compare <base> <head>` | Explain an arbitrary range — branch names, SHAs, `HEAD~3`, anything `git rev-parse` accepts |
| `/gitiviz:discuss <sha>` | Discuss one commit's story; raises a GitHub ticket only when you ask |
| `/gitiviz:ticket <sha> <title>` | File a GitHub issue from a commit's story, labeled `gitiviz` |
| `/gitiviz:open` | Open the generated HTML book |

Each command runs the deterministic engine, has Claude write narration through
the validated narration API, and opens `.gitiviz/dist/index.html`.

### The story loop

`/gitiviz:init` turns a repository into a living change book:

1. The engine analyzes the last 20 commits (`--commits N` to change that) and
   writes the fact manifests plus `.gitiviz/narration-request.json` — which
   carries the evidence inventory (`evidenceFiles`) and the diagram caps
   (`diagramLimits`) every proposed diagram must respect.
2. Claude reviews the project (README, package manifests, key entry points —
   all of it treated strictly as untrusted data), then writes
   `.gitiviz/narration-response.json`: a project summary, the purpose /
   systems / flows book chapters, a concept-level architecture diagram
   (colored clusters, human-named nodes anchored to real evidence files,
   verb-labeled edges — `docs/visual-reference.mmd` is the quality bar), and
   a plain-English story per change unit.
3. The validator rejects any claim or diagram anchor that is not backed by
   evidence; Claude fixes rejections and re-applies until the book renders.

From then on the **auto-story hook** keeps the book current: after every
`git commit` Claude runs in a repo that has a `.gitiviz/` directory, a
PostToolUse hook refreshes the facts for the new HEAD and prompts Claude to
write that commit's story through the same validated loop. In repositories
without `.gitiviz/` the hook is a silent no-op — nothing runs until you opt
in with `/gitiviz:init`.

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
plugins/claude-code    the shipped plugin: launcher, committed bundles, hooks
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
