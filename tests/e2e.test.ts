/**
 * End-to-end sweep (plan Task 21): demo fixture → full CLI run → the exact
 * artifacts a user gets. Asserts the whole pipeline holds together:
 *
 *   - manifests on disk are schema-valid
 *   - the HTML book has a chapter per meaningful change; grouped commits
 *     (fixup!, formatting-only) appear in the timeline ONLY, never as nav
 *   - template (no-agent) mode is honestly labeled: the ◇ AI-interpretation
 *     marker is ABSENT — it is reserved for merged agent narration
 *   - every evidence anchor points at a real path in the fixture repo
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEMO_FEATURE_BRANCH,
  makeDemoRepo,
  removeRepo,
  runGit
} from "@gitiviz/test-fixtures";
import {
  validateBookManifest,
  validateChangeManifest,
  type ChangeManifest,
  type EvidenceAnchor
} from "@gitiviz/schema";
import { runCli, type CliIo } from "@gitiviz/cli";

const MEANINGFUL_SUBJECTS = [
  "feat: add guest checkout route with validation",
  "refactor: rename order service to checkout service"
] as const;
const GROUPED_SUBJECTS = [
  "fixup! feat: add guest checkout route with validation",
  "style: reformat orders routes"
] as const;

interface CapturedIo extends CliIo {
  errText(): string;
}

function captureIo(): CapturedIo {
  const err: string[] = [];
  return {
    out: () => {},
    err: (text) => err.push(text),
    errText: () => err.join("\n")
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

let repo: string;
let out: string;
let exitCode: number;
let io: CapturedIo;
let html: string;
let change: ChangeManifest;

/** The demo repo gets a realistic origin: the book must carry this name. */
const ORIGIN_URL = "https://github.com/acme/demo-shop.git";
const EXPECTED_REPO_NAME = "demo-shop";

beforeAll(async () => {
  repo = await makeDemoRepo();
  await runGit(repo, ["remote", "add", "origin", ORIGIN_URL]);
  out = await mkdtemp(join(tmpdir(), "gitiviz-e2e-"));
  io = captureIo();
  exitCode = await runCli(
    ["compare", "main", DEMO_FEATURE_BRANCH, "--repo", repo, "--out", out],
    io
  );
  html = await readFile(join(out, "dist", "index.html"), "utf8");
  change = (await readJson(join(out, "manifests", "change.json"))) as ChangeManifest;
  return async () => {
    await removeRepo(repo);
  };
}, 120_000);

describe("e2e: manifests", () => {
  it("CLI exits 0 and both manifests on disk are schema-valid", async () => {
    expect(exitCode, io.errText()).toBe(0);
    const changeResult = validateChangeManifest(await readJson(join(out, "manifests", "change.json")));
    expect(changeResult.ok, JSON.stringify(changeResult)).toBe(true);
    const bookResult = validateBookManifest(await readJson(join(out, "manifests", "book.json")));
    expect(bookResult.ok, JSON.stringify(bookResult)).toBe(true);
  });

  it("a repo with an origin remote is named after the remote, not its directory", () => {
    // The temp checkout's directory is "gitiviz-e2e-…" (and "/repo" in the
    // plugin's Docker fallback) — the book must use the real project name.
    expect(change.repository.name).toBe(EXPECTED_REPO_NAME);
    expect(html).toContain(`<p class="sb-wordmark">${EXPECTED_REPO_NAME}</p>`);
    expect(html).toContain(`<title>${EXPECTED_REPO_NAME} — change book</title>`);
  });

  it("every evidence anchor points at a real path in the fixture repo", async () => {
    const listTree = async (rev: string): Promise<string[]> =>
      (await runGit(repo, ["ls-tree", "-r", "-z", "--name-only", rev]))
        .split("\0")
        .filter((p) => p.length > 0);
    const known = new Set([
      ...(await listTree("main")),
      ...(await listTree(DEMO_FEATURE_BRANCH))
    ]);
    // Directory anchors (system roll-ups like "src/routes") are real when
    // some tracked file lives under them.
    const isReal = (path: string): boolean =>
      known.has(path) || [...known].some((file) => file.startsWith(`${path}/`));

    const anchors: EvidenceAnchor[] = [
      ...change.entities.flatMap((entity) => entity.evidence ?? []),
      ...change.changeUnits.flatMap((unit) => unit.evidence ?? []),
      ...change.relationships.flatMap((rel) => rel.evidence ?? [])
    ];
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) {
      expect(isReal(anchor.path), `fabricated anchor path: ${anchor.path}`).toBe(true);
    }
    // The unit sweep is non-vacuous: every meaningful (non-grouped) change
    // unit carries its commit's touched paths as Sources evidence; grouped
    // commits (no chapter) carry none.
    for (const unit of change.changeUnits) {
      if (unit.grouped === true) {
        expect(unit.evidence, `grouped unit ${unit.id} must carry no evidence`).toBeUndefined();
      } else {
        expect(
          unit.evidence?.length ?? 0,
          `non-grouped unit ${unit.id} has no evidence paths`
        ).toBeGreaterThan(0);
      }
    }
  });
});

describe("e2e: HTML dashboard structure", () => {
  it("has a home card per meaningful change; grouped commits get no card", () => {
    // Sidebar tab nav: the five views, no per-commit tabs.
    const nav = html.match(/<nav[^>]*>[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(nav).not.toBe("");
    for (const tab of ["#home", "#overview", "#architecture", "#how-it-works", "#more"]) {
      expect(nav).toContain(`href="${tab}"`);
    }
    expect(nav).not.toContain("fixup!");
    expect(nav).not.toContain("style: reformat orders routes");
    // One card per meaningful change, full subject as the card title.
    expect(html.match(/class="cd-card cd-type-/g)).toHaveLength(2);
    for (const subject of MEANINGFUL_SUBJECTS) {
      expect(html).toContain(subject);
    }
    // Type tags derive from the conventional-commit prefix.
    expect(html).toContain(`>Feature</span>`);
    expect(html).toContain(`>Housekeeping</span>`);
    // The five view sections, home last (the CSS default-view technique).
    for (const id of ["overview", "architecture", "how-it-works", "more", "home"]) {
      expect(html).toContain(`<section id="${id}">`);
    }
    expect(html).not.toContain(`cd-type-fixup`);
  });

  it("gives every meaningful change its own :target page with a way back", () => {
    // Cards link to per-commit pages; grouped commits get neither.
    expect(html).toContain('href="#u0"');
    expect(html).toContain('href="#u1"');
    expect(html).not.toContain('href="#u2"');
    expect(html.match(/<section class="cp-page" id="u\d+"/g)).toHaveLength(2);
    for (const subject of MEANINGFUL_SUBJECTS) {
      expect(html).toMatch(new RegExp(`<h2 class="cp-title"[^>]*>${subject}</h2>`));
    }
    // Each page carries the prominent back link; "#" clears the fragment so
    // the home grid (the default view) returns.
    expect(html.match(/<a class="cp-back-link" href="#">← All changes<\/a>/g)).toHaveLength(2);
  });

  it("keeps meaningful commits as timeline nodes and grouped ones collapsed as housekeeping", () => {
    const timeline = html.match(/<ol class="timeline">[\s\S]*?<\/ol>/)?.[0] ?? "";
    expect(timeline).not.toBe("");
    for (const subject of MEANINGFUL_SUBJECTS) {
      expect(timeline).toContain(subject);
    }
    const housekeeping =
      html.match(/<details class="housekeeping">[\s\S]*?<\/details>/)?.[0] ?? "";
    expect(housekeeping).not.toBe("");
    expect(housekeeping).toContain("2 housekeeping commits");
    for (const subject of GROUPED_SUBJECTS) {
      expect(housekeeping).toContain(subject);
    }
  });

  it("stays scriptless and self-contained", () => {
    expect(html).not.toContain("<script");
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("default-src 'none'");
  });
});

describe("e2e: honest provenance labeling", () => {
  it("template mode never shows the ◇ AI-interpretation marker", () => {
    // No narration-response.json was present: everything in the book is a
    // deterministic restatement of derived facts, so nothing may be labeled
    // as AI interpretation.
    expect(html).not.toContain("AI interpretation");
    expect(html).not.toContain("◇");
  });

  it("merged agent narration IS marked as AI interpretation", async () => {
    const request = (await readJson(join(out, "narration-request.json"))) as {
      allowedChangeUnitIds: string[];
    };
    await writeFile(
      join(out, "narration-response.json"),
      JSON.stringify({
        changeUnits: [
          {
            id: request.allowedChangeUnitIds[0],
            humanTitle: "Guests can now check out",
            confidence: 0.9
          }
        ]
      }),
      "utf8"
    );
    const applyIo = captureIo();
    expect(await runCli(["apply-narration", "--out", out], applyIo), applyIo.errText()).toBe(0);
    const narratedHtml = await readFile(join(out, "dist", "index.html"), "utf8");
    expect(narratedHtml).toContain("Guests can now check out");
    expect(narratedHtml).toContain("◇");
    expect(narratedHtml).toContain("AI interpretation");
  }, 60_000);
});
