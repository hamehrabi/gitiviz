# Gitiviz — Design

**Date:** 2026-07-31
**Status:** Approved
**Working title:** Gitiviz (earlier working name: "GitWiki Visual Book")
**Repository:** https://github.com/hamehrabi/gitiviz

## One-line pitch

Turn any Git branch or commit range into a visual, plain-language story of what
changed — with evidence a developer can verify.

## Problem

AI coding agents produce hundreds or thousands of changed lines faster than
humans can understand or review them. Two audiences suffer:

- Developers drown in AI-generated diffs they must review.
- Non-technical people (PMs, stakeholders) cannot see what happened to the
  system at all.

Gitiviz is an explainable software change system and a control layer for
AI-assisted development — not a documentation generator.

## Decisions made during brainstorming

| Decision | Choice |
| --- | --- |
| Core wedge | All three pillars wanted (living book, explainable changes, scope control); center of gravity is **comprehension of AI-driven change** |
| Primary reader | **PM/stakeholder first**, developer evidence collapsed underneath — progressive disclosure is the load-bearing design principle |
| Goal | **Open-source product launch** |
| AI runtime | **Agent-native**: deterministic facts engine + renderer; narration flows through the coding agent (Claude Code plugin), validated before acceptance |
| Sequencing | **Change-first**: v0.1 is the branch/commit change explainer; the full book and scope contracts follow on the same schema |
| Form factor | **Plugin-first**: everything ships inside a Claude Code plugin (commands + bundled scripts); standalone CLI extracted later |
| Hosting | Existing GitHub repo `hamehrabi/gitiviz`, MIT license, installable as a Claude Code plugin marketplace repo |

## v0.1 product definition

1. Point it at a comparison — `main...feature/x`, `HEAD~1..HEAD`, a single
   commit, two SHAs. No PR, no remote required.
2. The deterministic engine builds an evidence graph: files, symbols, routes,
   packages, contracts, and how they changed (added / changed / removed /
   unchanged), every fact anchored to blob hashes and line ranges.
3. The agent narration loop: Claude receives the facts and writes plain-language
   titles, before/after descriptions, and impact statements through a validated
   API that rejects any claim not anchored to evidence. AI sentences are
   labelled `◇ inferred`; deterministic facts `✓ derived`.
4. Output: one self-contained HTML file — a draft-edition change book. Chapter
   per semantic change unit, one dominant visual each, PM-readable top layer,
   developer evidence collapsed underneath. Offline, no backend, shareable.
5. Context from a thin auto-generated book skeleton: Purpose (Ch 1, minimal),
   Systems map (Ch 3, grouped), Change history (Ch 10). The other seven
   chapters exist in the schema but render as "not yet written".

**First ecosystem:** TypeScript/JavaScript; analyzer interface language-neutral.

**Deferred:** scope contracts (v0.3), curated ten-chapter book (v0.2+),
incremental cache, non-TS languages, hosted PR adapters, standalone CLI (v0.4).

## Architecture (plugin-first)

The user installs one Claude Code plugin providing slash commands:

- `/visual-book-branch` — explain what the current branch changed vs a base
- `/visual-book-commit <sha>` — explain one commit vs its parent
- `/visual-book-compare <base> <head>` — arbitrary range
- `/visual-book-open` — open the generated HTML book

Pipeline for every command:

```
① Bundled deterministic script (no AI): reads Git — what files/functions/
   routes changed. Every fact gets an evidence anchor.
        ↓
② Claude (the agent in session) narrates the facts in plain language —
   constrained to reference only entity IDs and anchors from ①.
        ↓
③ Bundled validator: every claim must point at real evidence; violations
   are rejected back to the agent, never silently accepted. Provenance
   (derived vs inferred) is structurally impossible to fake.
        ↓
④ Bundled renderer: one self-contained HTML change book.
```

Essential analysis logic lives in bundled Node/TypeScript scripts referenced
via `${CLAUDE_PLUGIN_ROOT}` — never only in prompts or hooks. Claude does only
step ②, the storytelling.

### Repository layout

```
packages/
  schema/      JSON Schemas + TS types: BookManifest, ChangeManifest, Entity,
               Relationship, ChangeUnit, EvidenceAnchor. Versioned from day one.
  core/        Evidence graph construction, change-unit grouping, chapter
               projections, claim validation. Pure logic, no I/O.
  git/         Ref resolution, merge-base, diffs, renames, blob hashing.
               Never interpolates repo strings into shells.
  analyzers/   Pluggable Analyzer interface + TS/JS implementations:
               packages/workspaces, imports, exported symbols, HTTP routes.
  renderer/    Manifests → one self-contained HTML file.
  cli/         visualbook branch|commit|compare|validate (thin; also used
               by the plugin's bundled scripts and future CI).
plugins/
  claude-code/ Official plugin layout: commands + hooks that run the bundled
               scripts and drive the narration loop.
fixtures/      Small TS app with scripted Git history (branches, renames,
               merge commits) — test bed and demo. Includes a hostile-content
               fixture for security tests.
spec/          Published JSON Schemas.
docs/          Architecture, visual language, decisions (ADRs), plans.
```

Dropped from the original spec's layout for v0.1: `apps/viewer` (renderer emits
the viewer inline), `apps/demo`, the `gitdiagram-model` fixture (deferred to the
book-focused release).

## Canonical data model

Everything the tool knows lives in versioned JSON validated by JSON Schema.
HTML and diagrams are renderers, never the source of truth.

- **Entity** — a thing in the system. Stable ID, kind, human label first,
  technical label second, source anchors, base/head state, provenance.
- **Relationship** — an arrow with a verb ("Checkout page —creates order→
  Order service"). Verb required by schema. Kind, base/head state, evidence,
  provenance.
- **ChangeUnit** — one meaningful change grouping many diff hunks. Human and
  technical titles, type, before/after, affected entities/relationships,
  user/operational/security impact, evidence, verification, provenance, open
  questions. The stable anchor future comments attach to.
- **EvidenceAnchor** — repo-relative path + base/head blob hashes + source
  range (+ optional symbol/contract identity, content fingerprint, fallback
  text selector). Blob hashes keep evidence valid as branches move.

Provenance is mandatory on every claim: `declared` (human), `derived`
(deterministic ✓), `inferred` (AI ◇, only these carry confidence), `unknown`.
The schema makes it impossible to emit a claim without provenance, and the
validator makes it impossible for AI output to claim `derived`.

## Reader experience

1. One screen, one chapter. Chapter selector + Previous/Next. Nothing else.
2. Branch view opens first: branch name, base/merge-base, plain-language
   outcome sentence, count of meaningful changes, affected book chapters,
   small commit timeline.
3. Each change chapter: one sentence of human outcome; a small before→after
   diagram (5–12 entities, max 5 nodes horizontally, verb on every arrow);
   an explicit "what stayed unchanged" list.
4. Collapsed at the bottom: "Technical evidence ▸" — files, symbols,
   line-anchored source links. Full component graph also collapsed by default.
5. Works at 320px/736px/desktop, keyboard accessible, light/dark schemes,
   colour never the only carrier of meaning, zero runtime network requests.

Visual change language (used consistently everywhere): `+` New (dashed
boundary), `~` Changed (accent boundary), `−` Removed (faded/struck),
`=` Unchanged (quiet), `?` Human decision required, `✓` Deterministically
verified, `◇` AI interpretation.

## Security posture

The analyzed repository is hostile input:

- Never execute repo code; static parsing only.
- Never pass repo strings through a shell.
- Escape all repo-controlled strings before HTML/diagram output.
- Validate source links (no `javascript:`; allowed origins only).
- Strict CSP; renderer makes zero network calls.
- Narration validator treats repo text as possible prompt injection; Claude's
  instructions come from the plugin, never from repo content.
- No tokens/secrets/private source text in public artifacts.
- Hostile fixture: `<script>` filenames, malicious diagram labels,
  prompt-injection README text.

## Testing strategy

All tests run without a real AI provider — a deterministic template narrator
stands in for Claude (also the no-agent fallback).

1. **Schema tests** — valid/invalid manifests, spec-version rejection,
   provenance enforcement, missing-evidence handling.
2. **Git tests** — scripted fixture repos: default-branch build, branch vs
   base, single commit, arbitrary ranges, renames, deletes, merge commits,
   dirty tree, repo without a remote.
3. **Renderer tests** — exactly one chapter visible, selector and prev/next
   work, evidence and full graph collapsed by default, keyboard navigation,
   no horizontal overflow at 320px, escaping verified, no network requests.
4. **Security tests** — script injection in filename, unsafe source link,
   hostile labels, prompt-injection text, redaction.

## Roadmap

- **v0.1** — Change explainer (this design): plugin + change book HTML.
- **v0.2** — Fuller book: curated chapters, human corrections stored
  separately from generated facts, `/visual-book-init` interview flow.
- **v0.3** — Scope control: `/visual-book-plan` change contracts,
  `/visual-book-check-scope` concrete drift reporting (no numeric scores).
- **v0.4** — Standalone `visualbook` CLI package + CI usage; incremental
  cache when real-repo performance demands it.

Every release reuses the same schema; nothing is thrown away.

## Launch requirements

- GitHub repo `hamehrabi/gitiviz` (exists, MIT license).
- README centered on a 60-second demo.
- Repo structured as a Claude Code plugin marketplace so users can install
  via `/plugin marketplace add hamehrabi/gitiviz`.
- Final product name to be confirmed before README is written.

## Toolchain and runtime strategy (Docker-first)

Constraint: the development machine has no Node/npm/pnpm and cannot install
them; Docker is available and running.

- **Development:** all tooling (pnpm, TypeScript, esbuild, vitest) runs inside
  a `node:22` container with the repo volume-mounted. A `dev.sh` wrapper wraps
  `docker run` so builds and tests are one command. Nothing is installed on
  the host. CI (GitHub Actions) runs the same containerized build.
- **Plugin runtime:** bundled scripts are committed as dependency-free
  single-file `.mjs` artifacts (esbuild output) — end users never run
  `npm install`. This matches observed convention: no installed plugin in the
  wild ships `node_modules`. Git access is via shelling out to `git`
  (carefully, never interpolating repo strings), not a bundled library.
- **Node fallback:** the plugin's launcher probes for a working `node`; when
  absent but Docker is available, it transparently runs the bundled script via
  `docker run node:22-alpine` with the repo mounted. Missing both → clear
  error with install instructions (per plugin-dev marketplace guidance).
- **State separation:** generated output goes to the analyzed project's
  `.gitiviz/` directory (or `${CLAUDE_PLUGIN_DATA}`), never into
  `${CLAUDE_PLUGIN_ROOT}` (wiped on plugin update).

## Plugin packaging decisions (from best-practice research)

- Repo is simultaneously a Claude Code plugin, its own marketplace, and a
  TypeScript workspace (pattern proven by obra/superpowers):
  `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json` with the
  plugin entry `{"name": "gitiviz", "source": "./"}`.
- Commands are markdown orchestrators; computation lives in bundled scripts
  referenced via `${CLAUDE_PLUGIN_ROOT}` in both `allowed-tools` (pre-authorized,
  no permission prompts) and the command body (ralph-wiggum pattern).
- All runtime assets live under the plugin root — installs are cache copies;
  `../` paths and out-of-repo symlinks silently break.
- Omit `version` in plugin.json during active development (every commit
  becomes an update); adopt explicit semver at stable release.
- Dev loop without install: `claude --plugin-dir .`.

## Non-goals for v0.1

Perfect multi-language support, dynamic call-graph analysis, hosted SaaS,
enterprise permissions, vector database, GitHub-only assumptions, mandatory
PRs, replacing code review/tests/security analysis, full UML, a giant graph
as the primary interface.
