/**
 * The vertical slice: git layer → analyzers → core (graph, change units,
 * book skeleton) → narration loop → renderer, writing everything to the
 * analyzed repo's `.gitiviz/` output directory (never into the plugin).
 *
 * Outputs (all under the out dir):
 *   manifests/change.json     derived facts only — schema-validated before
 *                             write; an invalid manifest is a bug and fails
 *                             loudly, nothing is written past it
 *   manifests/book.json       ten-chapter skeleton, schema-validated
 *   narration-request.json    facts-only payload for the narrator (Claude)
 *   dist/index.html           self-contained scriptless change book
 *
 * Narration: if `narration-response.json` exists it is validated and merged
 * (`applyNarration` stamps everything "inferred"); a rejected response is a
 * hard error with the validator's actionable list — no partial merge, no
 * silent fallback. Without a response the deterministic template narrator
 * fills the same slots but stays "derived" (it restates facts, so nothing
 * gets the AI-interpretation marker). The on-disk change manifest always stays facts-only;
 * narration is merged in memory for rendering.
 *
 * Repo-derived strings are hostile: they ride through this module inert
 * (JSON/argv only) and are escaped exclusively by the renderer.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveRepoName } from "../repo-name.js";
import {
  diffRange,
  gitRaw,
  mergeBase,
  resolveRef,
  WORKTREE,
  type FileChange
} from "@gitiviz/git";
import {
  importExportAnalyzer,
  packageAnalyzer,
  routeAnalyzer,
  type Analyzer,
  type AnalyzerFact
} from "@gitiviz/analyzers";
import {
  applyNarration,
  applyTemplateNarration,
  buildBookManifest,
  buildChangeUnits,
  buildEvidenceGraph,
  buildNarrationRequest
} from "@gitiviz/core";
import {
  validateBookManifest,
  validateChangeManifest,
  type AnalysisLimitation,
  type BookManifest,
  type ChangeManifest
} from "@gitiviz/schema";
import {
  collectMermaidSources,
  compileDiagram,
  renderChangeBook,
  type MermaidRenderOptions
} from "@gitiviz/renderer";
import { prerenderMermaidDiagrams } from "../mermaid-prerender.js";
import { resolveRepoOrigin } from "../repo-origin.js";

/** Spec version stamped on every manifest this CLI generates. */
const SPEC_VERSION = "0.1.0";

const ANALYZERS: Analyzer[] = [packageAnalyzer, importExportAnalyzer, routeAnalyzer];

export interface CommandIo {
  out(text: string): void;
  err(text: string): void;
}

export interface CompareOptions {
  repoDir: string;
  outDir: string;
  baseRef: string;
  headRef: string;
  /**
   * Repository display name (--name flag / GITIVIZ_REPO_NAME env, already
   * resolved by the caller). When absent it is derived from the origin
   * remote URL, falling back to the directory basename.
   */
  repoName?: string;
  /**
   * Explicit repository web URL (GITIVIZ_REPO_ORIGIN env, passed through by
   * the caller). When absent it is derived from the origin remote URL; when
   * neither yields a usable http(s) URL, diagrams carry no click links.
   */
  repoOrigin?: string;
  io: CommandIo;
}

// ---------------------------------------------------------------------------
// Content + analyzer facts
// ---------------------------------------------------------------------------

interface CollectedFacts {
  baseFacts: AnalyzerFact[];
  headFacts: AnalyzerFact[];
  limitations: AnalysisLimitation[];
}

/** Blob content by sha — the path never touches a shell or a filesystem. */
async function blobContent(repoDir: string, blobSha: string): Promise<string> {
  const { stdout } = await gitRaw(repoDir, ["cat-file", "blob", blobSha]);
  return stdout;
}

function analyzeOneSide(
  path: string,
  content: string,
  into: AnalyzerFact[],
  limitations: AnalysisLimitation[]
): void {
  for (const analyzer of ANALYZERS) {
    if (!analyzer.appliesTo(path)) continue;
    try {
      const result = analyzer.analyze({ path, content });
      into.push(...result.facts);
      limitations.push(...result.limitations);
    } catch (error) {
      limitations.push({
        path,
        analyzer: analyzer.id,
        message:
          `Analyzer ${analyzer.id} failed on ${path}: ` +
          `${error instanceof Error ? error.message : String(error)}`
      });
    }
  }
}

/**
 * Run every applicable analyzer over the base- and head-side content of each
 * changed file. Content is read from blobs (never checked out); a worktree
 * head side reads the tracked file from disk. Per-file failures become
 * analysisLimitations, never crashes.
 */
async function collectFacts(
  repoDir: string,
  fileChanges: FileChange[],
  headIsWorktree: boolean
): Promise<CollectedFacts> {
  const baseFacts: AnalyzerFact[] = [];
  const headFacts: AnalyzerFact[] = [];
  const limitations: AnalysisLimitation[] = [];

  for (const fc of fileChanges) {
    const basePath = fc.oldPath ?? fc.path;
    if (fc.status !== "added" && fc.baseBlob !== undefined) {
      try {
        analyzeOneSide(basePath, await blobContent(repoDir, fc.baseBlob), baseFacts, limitations);
      } catch (error) {
        limitations.push({
          path: basePath,
          message:
            `Could not read base content of ${basePath}: ` +
            `${error instanceof Error ? error.message : String(error)}`
        });
      }
    }
    if (fc.status !== "deleted") {
      try {
        const content =
          fc.headBlob !== undefined
            ? await blobContent(repoDir, fc.headBlob)
            : headIsWorktree
              ? await readFile(join(repoDir, fc.path), "utf8")
              : null;
        if (content !== null) {
          analyzeOneSide(fc.path, content, headFacts, limitations);
        }
      } catch (error) {
        limitations.push({
          path: fc.path,
          message:
            `Could not read head content of ${fc.path}: ` +
            `${error instanceof Error ? error.message : String(error)}`
        });
      }
    }
  }

  return { baseFacts, headFacts, limitations };
}

// ---------------------------------------------------------------------------
// Shared file helpers
// ---------------------------------------------------------------------------

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJsonFile(path: string, hint: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`${path} not found — ${hint}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function manifestPaths(outDir: string): { change: string; book: string } {
  return {
    change: join(outDir, "manifests", "change.json"),
    book: join(outDir, "manifests", "book.json")
  };
}

async function loadValidatedManifests(
  outDir: string
): Promise<{ change: ChangeManifest; book: BookManifest }> {
  const paths = manifestPaths(outDir);
  const hint = "run `gitiviz compare` (or branch/commit) first";
  const changeRaw = await readJsonFile(paths.change, hint);
  const bookRaw = await readJsonFile(paths.book, hint);
  const change = validateChangeManifest(changeRaw);
  if (!change.ok) {
    throw new Error(`${paths.change} is invalid:\n  - ${change.errors.join("\n  - ")}`);
  }
  const book = validateBookManifest(bookRaw);
  if (!book.ok) {
    throw new Error(`${paths.book} is invalid:\n  - ${book.errors.join("\n  - ")}`);
  }
  return { change: change.value, book: book.value };
}

/** Merge a narration response into the manifest or fail with the error list. */
function mergeNarration(
  change: ChangeManifest,
  response: unknown,
  source: string
): ChangeManifest {
  const merged = applyNarration(change, response);
  if (!merged.ok) {
    throw new Error(`${source} rejected:\n  - ${merged.errors.join("\n  - ")}`);
  }
  return merged.value;
}

/** How diagram sources become SVGs — injectable for renderToDist tests. */
export type DiagramPrerenderer = typeof prerenderMermaidDiagrams;

export interface RenderToDistOptions {
  outDir: string;
  book: BookManifest;
  /** The (narration-merged, in-memory) change manifest to render. */
  change: ChangeManifest;
  io: CommandIo;
  /** Sidebar display name; see CompareOptions.repoName. */
  repoName?: string | undefined;
  /**
   * Repository web URL (e.g. "https://github.com/acme/demo") resolved via
   * resolveRepoOrigin, or null/absent when unknown. Diagram click links
   * compile ONLY when this and a real head sha are both known, and every
   * link is validated against this origin by the renderer.
   */
  repoOrigin?: string | null | undefined;
  /** Head commit sha for blob links; WORKTREE (or absent) disables links. */
  headSha?: string | undefined;
  /** Mermaid prerender chain; defaults to the real one. */
  prerender?: DiagramPrerenderer | undefined;
}

/**
 * Render the book to `<out>/dist/index.html` with real Mermaid diagrams:
 * compile every diagram source (click-through links included when the repo
 * origin and head sha are known), prerender through the chain in
 * mermaid-prerender.ts, and fall back honestly per slot when no engine is
 * available.
 */
export async function renderToDist(options: RenderToDistOptions): Promise<void> {
  const { outDir, book, change, io } = options;
  const prerender = options.prerender ?? prerenderMermaidDiagrams;

  const repoOrigin = options.repoOrigin ?? null;
  let originHost: string | null = null;
  if (repoOrigin !== null) {
    try {
      originHost = new URL(repoOrigin).origin;
    } catch {
      originHost = null;
    }
  }
  const headSha =
    options.headSha !== undefined && options.headSha !== WORKTREE
      ? options.headSha
      : undefined;
  const allowedOrigins = originHost !== null ? [originHost] : [];
  const mermaidOptions: MermaidRenderOptions = {
    ...(repoOrigin !== null && originHost !== null && headSha !== undefined
      ? { linkBase: `${repoOrigin}/blob/${headSha}` }
      : {}),
    ...(allowedOrigins.length > 0 ? { allowedOrigins } : {})
  };

  const sources = collectMermaidSources(book, change, mermaidOptions);
  const { svgs, notes } = await prerender(sources, { outDir, allowedOrigins });
  for (const note of notes) io.out(note);

  const html = renderChangeBook(book, change, {
    renderDiagram: compileDiagram,
    ...(options.repoName !== undefined ? { repoName: options.repoName } : {}),
    mermaid: { ...mermaidOptions, svgs }
  });
  await mkdir(join(outDir, "dist"), { recursive: true });
  const htmlPath = join(outDir, "dist", "index.html");
  await writeFile(htmlPath, html, "utf8");
  io.out(`wrote ${htmlPath}`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function runCompare(options: CompareOptions): Promise<void> {
  const { repoDir, outDir, baseRef, headRef, io } = options;

  // Display name: caller-resolved (--name / env) or origin-remote basename,
  // last resort the directory basename ("repo" in the Docker fallback).
  const repoName =
    options.repoName ?? (await resolveRepoName({ repoDir }));

  // Web origin for diagram click-through links: GITIVIZ_REPO_ORIGIN env
  // (passed through by the caller) or the origin remote's web form.
  const repoOrigin = await resolveRepoOrigin({
    repoDir,
    envOrigin: options.repoOrigin
  });

  // 1. Facts: diffs, analyzer facts, evidence graph, change units.
  const baseSha = await resolveRef(repoDir, baseRef);
  const headIsWorktree = headRef === WORKTREE;
  const headSha = headIsWorktree ? WORKTREE : await resolveRef(repoDir, headRef);
  const fileChanges = await diffRange(repoDir, baseSha, headSha);
  const facts = await collectFacts(repoDir, fileChanges, headIsWorktree);
  const graph = buildEvidenceGraph({
    fileChanges,
    baseFacts: facts.baseFacts,
    headFacts: facts.headFacts
  });
  const units = await buildChangeUnits({
    repoDir,
    baseRef: baseSha,
    headRef: headSha,
    entities: graph.entities
  });

  const manifest: ChangeManifest = {
    specVersion: SPEC_VERSION,
    repository: { name: repoName },
    baseRevision: baseSha,
    headRevision: headSha,
    entities: graph.entities,
    relationships: graph.relationships,
    changeUnits: units.changeUnits,
    analysisLimitations: [...facts.limitations, ...units.analysisLimitations]
  };

  // 2. Validate before writing — an invalid generated manifest is a bug.
  const checkedChange = validateChangeManifest(JSON.parse(JSON.stringify(manifest)));
  if (!checkedChange.ok) {
    throw new Error(
      `generated change manifest is invalid (this is a gitiviz bug):\n  - ` +
        checkedChange.errors.join("\n  - ")
    );
  }
  const book = buildBookManifest(manifest);
  const checkedBook = validateBookManifest(JSON.parse(JSON.stringify(book)));
  if (!checkedBook.ok) {
    throw new Error(
      `generated book manifest is invalid (this is a gitiviz bug):\n  - ` +
        checkedBook.errors.join("\n  - ")
    );
  }

  const paths = manifestPaths(outDir);
  await mkdir(join(outDir, "manifests"), { recursive: true });
  await writeJson(paths.change, manifest);
  io.out(`wrote ${paths.change}`);
  await writeJson(paths.book, book);
  io.out(`wrote ${paths.book}`);

  // 3. Narration request for the agent.
  const request = buildNarrationRequest(manifest);
  const requestPath = join(outDir, "narration-request.json");
  await writeJson(requestPath, request);
  io.out(`wrote ${requestPath}`);

  // 4. Narration: validated agent response if present, else the template.
  const responsePath = join(outDir, "narration-response.json");
  let narrated: ChangeManifest;
  let responseRaw: unknown | undefined;
  try {
    responseRaw = JSON.parse(await readFile(responsePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `${responsePath} is not valid JSON: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (responseRaw !== undefined) {
    narrated = mergeNarration(manifest, responseRaw, responsePath);
    io.out(`merged narration from ${responsePath}`);
  } else {
    // Template output is a deterministic restatement of derived facts, so it
    // keeps provenance "derived" — no ◇ AI-interpretation marker.
    narrated = applyTemplateNarration(manifest);
    io.out("no narration-response.json — used the deterministic template narrator");
  }

  // 5. Render.
  await renderToDist({
    outDir,
    book,
    change: narrated,
    io,
    repoName,
    repoOrigin,
    headSha
  });
}

export interface BranchOptions {
  repoDir: string;
  outDir: string;
  /** Explicit base ref; defaults to main/master. */
  baseRef?: string;
  /** See CompareOptions.repoName. */
  repoName?: string;
  /** See CompareOptions.repoOrigin. */
  repoOrigin?: string;
  io: CommandIo;
}

async function refExists(repoDir: string, ref: string): Promise<boolean> {
  try {
    await resolveRef(repoDir, ref);
    return true;
  } catch {
    return false;
  }
}

/** Compare HEAD against its merge-base with the base branch (main/master). */
export async function runBranch(options: BranchOptions): Promise<void> {
  const { repoDir, outDir, io } = options;
  let base = options.baseRef;
  if (base === undefined) {
    if (await refExists(repoDir, "main")) base = "main";
    else if (await refExists(repoDir, "master")) base = "master";
    else {
      throw new Error(
        "no main or master branch found — pass a base ref: gitiviz branch <base-ref>"
      );
    }
  }
  const baseSha = await mergeBase(repoDir, base, "HEAD");
  await runCompare({
    repoDir,
    outDir,
    baseRef: baseSha,
    headRef: "HEAD",
    ...(options.repoName !== undefined ? { repoName: options.repoName } : {}),
    ...(options.repoOrigin !== undefined ? { repoOrigin: options.repoOrigin } : {}),
    io
  });
}

export interface InitOptions {
  repoDir: string;
  outDir: string;
  /** How many trailing commits to analyze (clamped to the history). */
  commits: number;
  /** See CompareOptions.repoName. */
  repoName?: string;
  /** See CompareOptions.repoOrigin. */
  repoOrigin?: string;
  io: CommandIo;
}

/**
 * Bootstrap the story loop: run the full pipeline over the last N commits
 * (clamped to the available history) and print the narration next steps.
 * This is the engine half of /gitiviz:init — the agent half reads
 * narration-request.json and writes narration-response.json.
 */
export async function runInit(options: InitOptions): Promise<void> {
  const { repoDir, outDir, commits, io } = options;
  const headSha = await resolveRef(repoDir, "HEAD");
  const { stdout } = await gitRaw(repoDir, ["rev-list", "--count", headSha]);
  const commitCount = Number(stdout.trim());
  if (!Number.isInteger(commitCount) || commitCount < 2) {
    throw new Error(
      "this repository has fewer than 2 commits — gitiviz init needs at least 2 commits " +
        "to build a change range. Make another commit and rerun."
    );
  }
  // First-parent depth: HEAD~span must exist even across merges, so clamp to
  // the first-parent chain length rather than the full rev-list count.
  const { stdout: firstParentOut } = await gitRaw(repoDir, [
    "rev-list",
    "--count",
    "--first-parent",
    headSha
  ]);
  const firstParentDepth = Number(firstParentOut.trim());
  const span = Math.min(commits, firstParentDepth - 1);
  const baseSha = await resolveRef(repoDir, `${headSha}~${span}`);
  io.out(`analyzing the last ${span} commit${span === 1 ? "" : "s"} (${commitCount} in history)`);
  await runCompare({
    repoDir,
    outDir,
    baseRef: baseSha,
    headRef: headSha,
    ...(options.repoName !== undefined ? { repoName: options.repoName } : {}),
    ...(options.repoOrigin !== undefined ? { repoOrigin: options.repoOrigin } : {}),
    io
  });
  io.out(
    [
      "",
      "Next steps (the story loop):",
      `  1. Read ${join(outDir, "narration-request.json")} — it lists the only entity/`,
      "     change-unit ids you may reference, the evidenceFiles inventory diagram",
      "     nodes must anchor to, and the diagram caps (diagramLimits).",
      `  2. Write ${join(outDir, "narration-response.json")} with the project summary,`,
      "     chapters, architectureDiagram, and a story per change unit.",
      "  3. Run `gitiviz apply-narration` to validate, merge, and re-render the book."
    ].join("\n")
  );
}

export interface CommitOptions {
  repoDir: string;
  outDir: string;
  ref: string;
  /** See CompareOptions.repoName. */
  repoName?: string;
  /** See CompareOptions.repoOrigin. */
  repoOrigin?: string;
  io: CommandIo;
}

/** Explain a single commit: compare sha~1..sha. */
export async function runCommit(options: CommitOptions): Promise<void> {
  const headSha = await resolveRef(options.repoDir, options.ref);
  await runCompare({
    repoDir: options.repoDir,
    outDir: options.outDir,
    baseRef: `${headSha}~1`,
    headRef: headSha,
    ...(options.repoName !== undefined ? { repoName: options.repoName } : {}),
    ...(options.repoOrigin !== undefined ? { repoOrigin: options.repoOrigin } : {}),
    io: options.io
  });
}

export interface ValidateOptions {
  outDir: string;
  io: CommandIo;
}

/** Re-validate the manifests on disk; throws (exit 1) when anything is off. */
export async function runValidate(options: ValidateOptions): Promise<void> {
  await loadValidatedManifests(options.outDir);
  options.io.out("manifests are valid");
}

export interface ApplyNarrationOptions {
  outDir: string;
  /**
   * The analyzed repository directory — used only to derive the web origin
   * for diagram click links from the origin remote. Optional: without it
   * (and without GITIVIZ_REPO_ORIGIN) diagrams simply carry no links.
   */
  repoDir?: string;
  /**
   * Explicit display-name override (--name / env only). Unlike compare there
   * is no directory fallback here: the manifest on disk already carries the
   * resolved name and re-deriving it from the cwd could regress it.
   */
  repoName?: string;
  /** See CompareOptions.repoOrigin. */
  repoOrigin?: string;
  io: CommandIo;
}

/**
 * Merge narration-response.json into the manifests already on disk and
 * re-render — no re-analysis. This is the second half of the agent loop.
 */
export async function runApplyNarration(options: ApplyNarrationOptions): Promise<void> {
  const { outDir, io } = options;
  const { change, book } = await loadValidatedManifests(outDir);
  const responsePath = join(outDir, "narration-response.json");
  const responseRaw = await readJsonFile(
    responsePath,
    "write one from narration-request.json first"
  );
  const narrated = mergeNarration(change, responseRaw, responsePath);
  io.out(`merged narration from ${responsePath}`);
  const repoOrigin =
    options.repoDir !== undefined || options.repoOrigin !== undefined
      ? await resolveRepoOrigin({
          repoDir: options.repoDir ?? ".",
          envOrigin: options.repoOrigin
        })
      : null;
  await renderToDist({
    outDir,
    book,
    change: narrated,
    io,
    repoName: options.repoName,
    repoOrigin,
    // The manifest's head revision is the sha the analysis actually saw.
    headSha: change.headRevision
  });
}
