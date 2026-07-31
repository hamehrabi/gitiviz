/**
 * Vertical-slice tests for the gitiviz CLI: compare / branch / commit /
 * validate / apply-narration against the scripted demo and hostile fixture
 * repos. Everything runs through `runCli` (no child process): exit codes and
 * captured stdout/stderr are the contract.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { basename } from "node:path";
import {
  DEMO_FEATURE_BRANCH,
  HOSTILE_FILE,
  HOSTILE_SYMBOL,
  makeDemoRepo,
  makeHostileRepo,
  removeRepo,
  runGit
} from "@gitiviz/test-fixtures";
import {
  validateBookManifest,
  validateChangeManifest,
  type ChangeManifest
} from "@gitiviz/schema";
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
  return mkdtemp(join(tmpdir(), "gitiviz-out-"));
}

let demoRepo: string;
let mainSha: string;
let featureSha: string;

beforeAll(async () => {
  demoRepo = await makeDemoRepo();
  mainSha = (await runGit(demoRepo, ["rev-parse", "main"])).trim();
  featureSha = (await runGit(demoRepo, ["rev-parse", DEMO_FEATURE_BRANCH])).trim();
  return async () => {
    await removeRepo(demoRepo);
  };
}, 60_000);

describe("gitiviz compare (vertical slice on the demo repo)", () => {
  let out: string;
  let exitCode: number;
  let io: CapturedIo;

  beforeAll(async () => {
    out = await newOutDir();
    io = captureIo();
    exitCode = await runCli(
      ["compare", "main", DEMO_FEATURE_BRANCH, "--repo", demoRepo, "--out", out],
      io
    );
  }, 60_000);

  it("exits 0 and writes schema-valid manifests under <out>/manifests", async () => {
    expect(exitCode, io.errText()).toBe(0);
    const change = await readJson(join(out, "manifests", "change.json"));
    const book = await readJson(join(out, "manifests", "book.json"));
    const changeResult = validateChangeManifest(change);
    expect(changeResult.ok, JSON.stringify(changeResult)).toBe(true);
    const bookResult = validateBookManifest(book);
    expect(bookResult.ok, JSON.stringify(bookResult)).toBe(true);
    if (changeResult.ok) {
      expect(changeResult.value.baseRevision).toBe(mainSha);
      expect(changeResult.value.headRevision).toBe(featureSha);
    }
  });

  it("keeps change.json facts-only: derived provenance, humanTitle unfilled", async () => {
    const change = (await readJson(join(out, "manifests", "change.json"))) as ChangeManifest;
    expect(change.changeUnits.length).toBeGreaterThan(0);
    for (const unit of change.changeUnits) {
      expect(unit.provenance).toBe("derived");
      expect(unit.humanTitle ?? null).toBeNull();
    }
    for (const entity of change.entities) {
      expect(entity.provenance).toBe("derived");
    }
  });

  it("writes a facts-only narration request listing exactly the manifest ids", async () => {
    const change = (await readJson(join(out, "manifests", "change.json"))) as ChangeManifest;
    const request = (await readJson(join(out, "narration-request.json"))) as {
      allowedEntityIds: string[];
      allowedChangeUnitIds: string[];
      changeUnits: { id: string; technicalTitle: string }[];
    };
    expect(request.allowedChangeUnitIds.sort()).toEqual(
      change.changeUnits.map((u) => u.id).sort()
    );
    expect(request.allowedEntityIds.sort()).toEqual(
      change.entities.map((e) => e.id).sort()
    );
    expect(request.changeUnits[0]?.technicalTitle).toBeTruthy();
  });

  it("renders dist/index.html with a chapter per meaningful change (template fallback)", async () => {
    const html = await readFile(join(out, "dist", "index.html"), "utf8");
    // The two meaningful commits become chapters; template narration reuses
    // the commit subject as the human title.
    expect(html).toContain("feat: add guest checkout route with validation");
    expect(html).toContain("refactor: rename order service to checkout service");
    // The fixup commit is grouped: present in the timeline, but not a nav label.
    const navLabels = html.match(/<nav[^>]*>[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(navLabels).not.toContain("fixup!");
    expect(html).not.toContain("<script");
  });
});

describe("gitiviz compare (hostile repo stays inert)", () => {
  it("escapes hostile filenames and symbols; no scripts, no javascript: hrefs", async () => {
    const hostileRepo = await makeHostileRepo();
    try {
      const out = await newOutDir();
      const io = captureIo();
      const exitCode = await runCli(
        ["compare", "main~1", "main", "--repo", hostileRepo, "--out", out],
        io
      );
      expect(exitCode, io.errText()).toBe(0);
      const html = await readFile(join(out, "dist", "index.html"), "utf8");
      expect(html).not.toContain(HOSTILE_FILE);
      expect(html).not.toContain(HOSTILE_SYMBOL);
      expect(html).not.toContain("<script");
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;.ts");
      expect(html).not.toMatch(/href\s*=\s*["']?javascript:/i);
    } finally {
      await removeRepo(hostileRepo);
    }
  }, 60_000);
});

describe("narration-response handling", () => {
  let out: string;

  beforeAll(async () => {
    out = await newOutDir();
    const io = captureIo();
    expect(
      await runCli(
        ["compare", "main", DEMO_FEATURE_BRANCH, "--repo", demoRepo, "--out", out],
        io
      )
    ).toBe(0);
  }, 60_000);

  it("merges a valid narration-response.json on the next run (stamped inferred in HTML, not in change.json)", async () => {
    const request = (await readJson(join(out, "narration-request.json"))) as {
      allowedChangeUnitIds: string[];
    };
    const unitId = request.allowedChangeUnitIds[0]!;
    await writeFile(
      join(out, "narration-response.json"),
      JSON.stringify({
        changeUnits: [
          { id: unitId, humanTitle: "Guests can now check out", summary: "Adds a guest path." }
        ]
      }),
      "utf8"
    );
    const io = captureIo();
    const exitCode = await runCli(
      ["compare", "main", DEMO_FEATURE_BRANCH, "--repo", demoRepo, "--out", out],
      io
    );
    expect(exitCode, io.errText()).toBe(0);
    const html = await readFile(join(out, "dist", "index.html"), "utf8");
    expect(html).toContain("Guests can now check out");
    // The on-disk change manifest stays facts-only.
    const change = (await readJson(join(out, "manifests", "change.json"))) as ChangeManifest;
    for (const unit of change.changeUnits) {
      expect(unit.provenance).toBe("derived");
    }
  }, 60_000);

  it("rejects an invalid narration response loudly (exit 1, actionable error)", async () => {
    await writeFile(
      join(out, "narration-response.json"),
      JSON.stringify({ changeUnits: [{ id: "no-such-unit", humanTitle: "x" }] }),
      "utf8"
    );
    const io = captureIo();
    const exitCode = await runCli(
      ["compare", "main", DEMO_FEATURE_BRANCH, "--repo", demoRepo, "--out", out],
      io
    );
    expect(exitCode).toBe(1);
    expect(io.errText()).toContain("narration-response.json");
    expect(io.errText()).toContain("no-such-unit");
  }, 60_000);

  it("apply-narration re-renders from manifests on disk without re-analyzing", async () => {
    const request = (await readJson(join(out, "narration-request.json"))) as {
      allowedChangeUnitIds: string[];
    };
    const unitId = request.allowedChangeUnitIds[0]!;
    await writeFile(
      join(out, "narration-response.json"),
      JSON.stringify({ changeUnits: [{ id: unitId, humanTitle: "Renarrated title" }] }),
      "utf8"
    );
    const io = captureIo();
    const exitCode = await runCli(["apply-narration", "--out", out], io);
    expect(exitCode, io.errText()).toBe(0);
    const html = await readFile(join(out, "dist", "index.html"), "utf8");
    expect(html).toContain("Renarrated title");
  }, 60_000);
});

describe("repository display name resolution through the CLI", () => {
  const compareArgs = (out: string): string[] => [
    "compare",
    "main",
    DEMO_FEATURE_BRANCH,
    "--repo",
    demoRepo,
    "--out",
    out
  ];

  async function repoNameIn(out: string): Promise<string> {
    const change = (await readJson(join(out, "manifests", "change.json"))) as ChangeManifest;
    return change.repository.name;
  }

  it("--name flag beats the GITIVIZ_REPO_NAME env", async () => {
    const out = await newOutDir();
    const io = captureIo();
    const exitCode = await runCli([...compareArgs(out), "--name", "flag-name"], io, {
      GITIVIZ_REPO_NAME: "env-name"
    });
    expect(exitCode, io.errText()).toBe(0);
    expect(await repoNameIn(out)).toBe("flag-name");
  }, 60_000);

  it("GITIVIZ_REPO_NAME env is used when no --name is given (Docker fallback)", async () => {
    const out = await newOutDir();
    const io = captureIo();
    const exitCode = await runCli(compareArgs(out), io, {
      GITIVIZ_REPO_NAME: "env-name"
    });
    expect(exitCode, io.errText()).toBe(0);
    expect(await repoNameIn(out)).toBe("env-name");
    const html = await readFile(join(out, "dist", "index.html"), "utf8");
    expect(html).toContain('<p class="sb-wordmark">env-name</p>');
  }, 60_000);

  it("falls back to the origin remote's repo name (strips .git), then dir basename", async () => {
    const out = await newOutDir();
    await runGit(demoRepo, [
      "remote",
      "add",
      "origin",
      "git@github.com:acme/demo-shop.git"
    ]);
    try {
      const io = captureIo();
      const exitCode = await runCli(compareArgs(out), io, {});
      expect(exitCode, io.errText()).toBe(0);
      expect(await repoNameIn(out)).toBe("demo-shop");
    } finally {
      await runGit(demoRepo, ["remote", "remove", "origin"]);
    }

    // Without a remote the directory basename remains the last resort.
    const out2 = await newOutDir();
    const io2 = captureIo();
    expect(await runCli(compareArgs(out2), io2, {}), io2.errText()).toBe(0);
    expect(await repoNameIn(out2)).toBe(basename(demoRepo));
  }, 60_000);
});

describe("thin wrappers", () => {
  it("branch defaults base to the merge-base with main", async () => {
    const out = await newOutDir();
    const io = captureIo();
    const exitCode = await runCli(["branch", "--repo", demoRepo, "--out", out], io);
    expect(exitCode, io.errText()).toBe(0);
    const change = (await readJson(join(out, "manifests", "change.json"))) as ChangeManifest;
    // feature/guest-checkout branched from the tip of main.
    expect(change.baseRevision).toBe(mainSha);
    expect(change.headRevision).toBe(featureSha);
  }, 60_000);

  it("commit <sha> delegates to compare sha~1..sha", async () => {
    const out = await newOutDir();
    const io = captureIo();
    const exitCode = await runCli(["commit", featureSha, "--repo", demoRepo, "--out", out], io);
    expect(exitCode, io.errText()).toBe(0);
    const change = (await readJson(join(out, "manifests", "change.json"))) as ChangeManifest;
    expect(change.headRevision).toBe(featureSha);
    expect(change.changeUnits).toHaveLength(1);
    expect(change.changeUnits[0]?.commits).toEqual([featureSha]);
  }, 60_000);

  it("validate re-validates manifests on disk (0 when valid, 1 when broken)", async () => {
    const out = await newOutDir();
    expect(
      await runCli(
        ["compare", "main", DEMO_FEATURE_BRANCH, "--repo", demoRepo, "--out", out],
        captureIo()
      )
    ).toBe(0);
    expect(await runCli(["validate", "--out", out], captureIo())).toBe(0);

    await writeFile(join(out, "manifests", "change.json"), '{"broken":true}', "utf8");
    const io = captureIo();
    expect(await runCli(["validate", "--out", out], io)).toBe(1);
    expect(io.errText()).toContain("change.json");
  }, 60_000);

  it("unknown commands exit 1 with usage", async () => {
    const io = captureIo();
    expect(await runCli(["frobnicate"], io)).toBe(1);
    expect(io.errText()).toContain("Usage");
  });
});
