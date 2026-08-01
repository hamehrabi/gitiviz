/**
 * Tests for `gitiviz init` — the story-loop bootstrap. It runs the full
 * pipeline over the last N commits (default 20, clamped to the history),
 * writes the manifests + narration request (evidence inventory and diagram
 * caps included), and prints the next steps of the narration loop.
 */
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  commitFile,
  makeDemoRepo,
  makeRepo,
  removeRepo,
  runGit
} from "@gitiviz/test-fixtures";
import { type ChangeManifest } from "@gitiviz/schema";
import { runCli, type CliIo } from "./index.js";

interface CapturedIo extends CliIo {
  outText(): string;
  errText(): string;
}

function captureIo(): CapturedIo {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    outText: () => out.join("\n"),
    errText: () => err.join("\n")
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function newOutDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "gitiviz-init-out-"));
}

let demoRepo: string;
let headSha: string;
let rootSha: string;

beforeAll(async () => {
  demoRepo = await makeDemoRepo(); // 7 commits, feature branch checked out
  headSha = (await runGit(demoRepo, ["rev-parse", "HEAD"])).trim();
  rootSha = (
    await runGit(demoRepo, ["rev-list", "--max-parents=0", "HEAD"])
  ).trim();
  return async () => {
    await removeRepo(demoRepo);
  };
}, 60_000);

describe("gitiviz init", () => {
  it("analyzes the last N commits with --commits N", async () => {
    const out = await newOutDir();
    const io = captureIo();
    const exitCode = await runCli(
      ["init", "--commits", "2", "--repo", demoRepo, "--out", out],
      io
    );
    expect(exitCode, io.errText()).toBe(0);
    const change = (await readJson(join(out, "manifests", "change.json"))) as ChangeManifest;
    const expectedBase = (await runGit(demoRepo, ["rev-parse", "HEAD~2"])).trim();
    expect(change.baseRevision).toBe(expectedBase);
    expect(change.headRevision).toBe(headSha);
  }, 60_000);

  it("defaults to 20 commits and clamps to the available history", async () => {
    const out = await newOutDir();
    const io = captureIo();
    const exitCode = await runCli(["init", "--repo", demoRepo, "--out", out], io);
    expect(exitCode, io.errText()).toBe(0);
    const change = (await readJson(join(out, "manifests", "change.json"))) as ChangeManifest;
    // The demo repo has 7 commits, so the clamped base is the root commit.
    expect(change.baseRevision).toBe(rootSha);
    expect(change.headRevision).toBe(headSha);
  }, 60_000);

  it("writes a narration request carrying the evidence inventory and diagram caps", async () => {
    const out = await newOutDir();
    const io = captureIo();
    expect(
      await runCli(["init", "--commits", "3", "--repo", demoRepo, "--out", out], io),
      io.errText()
    ).toBe(0);
    const request = (await readJson(join(out, "narration-request.json"))) as {
      evidenceFiles: string[];
      diagramLimits: {
        architecture: { maxNodes: number; maxClusters: number };
        story: { maxNodes: number };
        tones: string[];
      };
    };
    expect(Array.isArray(request.evidenceFiles)).toBe(true);
    expect(request.evidenceFiles.length).toBeGreaterThan(0);
    expect(request.diagramLimits.architecture).toEqual({ maxNodes: 20, maxClusters: 6 });
    expect(request.diagramLimits.story).toEqual({ maxNodes: 7 });
    expect(request.diagramLimits.tones).toContain("neutral");
  }, 60_000);

  it("prints the next steps of the story loop", async () => {
    const out = await newOutDir();
    const io = captureIo();
    expect(
      await runCli(["init", "--commits", "2", "--repo", demoRepo, "--out", out], io),
      io.errText()
    ).toBe(0);
    const stdout = io.outText();
    expect(stdout).toContain("narration-request.json");
    expect(stdout).toContain("narration-response.json");
    expect(stdout).toContain("apply-narration");
  }, 60_000);

  it("rejects a non-positive or non-integer --commits value", async () => {
    for (const bad of ["0", "-3", "abc", "2.5"]) {
      const io = captureIo();
      expect(await runCli(["init", "--commits", bad, "--repo", demoRepo], io)).toBe(1);
      expect(io.errText()).toContain("--commits");
    }
  }, 60_000);

  it("rejects --commits on any other command", async () => {
    const io = captureIo();
    expect(
      await runCli(["branch", "--commits", "5", "--repo", demoRepo], io)
    ).toBe(1);
    expect(io.errText()).toContain("--commits");
  }, 60_000);

  it("fails with an actionable error on a single-commit repository", async () => {
    const repo = await makeRepo();
    try {
      await commitFile(repo, "readme.md", "hello\n", "chore: first commit");
      const out = await newOutDir();
      const io = captureIo();
      expect(await runCli(["init", "--repo", repo, "--out", out], io)).toBe(1);
      expect(io.errText()).toMatch(/at least (2|two) commits/);
    } finally {
      await removeRepo(repo);
    }
  }, 60_000);
});
