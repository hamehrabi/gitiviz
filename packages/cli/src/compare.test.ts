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
import type { BookManifest } from "@gitiviz/schema";
import { CHAPTER_IDS } from "@gitiviz/schema";
import { renderToDist, type DiagramPrerenderer } from "./commands/compare.js";
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

describe("renderToDist mermaid wiring (stub prerenderer)", () => {
  const HEAD_SHA = "b".repeat(40);

  function fixtureChange(): ChangeManifest {
    return {
      specVersion: "0.1.0",
      repository: { name: "demo-app" },
      baseRevision: "a".repeat(40),
      headRevision: HEAD_SHA,
      entities: [
        {
          id: "ent-a",
          kind: "module",
          humanLabel: "Order service",
          baseState: "unchanged",
          headState: "changed",
          provenance: "derived",
          evidence: [{ path: "src/orderService.ts" }]
        }
      ],
      relationships: [],
      changeUnits: [
        {
          id: "unit-1",
          technicalTitle: "feat: add checkout",
          commits: ["c".repeat(40)],
          entities: ["ent-a"],
          provenance: "derived"
        }
      ],
      analysisLimitations: [],
      architectureDiagram: {
        clusters: [{ id: "core", title: "Core", tone: "blue" }],
        nodes: [
          {
            id: "svc",
            cluster: "core",
            humanLabel: "Order service",
            role: "order logic",
            file: "src/orderService.ts"
          }
        ],
        edges: [],
        provenance: "inferred",
        confidence: 0.9
      }
    };
  }

  function fixtureBook(): BookManifest {
    return {
      specVersion: "0.1.0",
      repository: { name: "demo-app" },
      chapters: CHAPTER_IDS.map((id) => ({
        id,
        title: `Title for ${id}`,
        status: id === "systems" ? ("generated" as const) : ("not-written" as const)
      }))
    };
  }

  interface StubCall {
    sources: { id: string; text: string }[];
    options: { outDir: string; allowedOrigins?: readonly string[] };
  }

  function stubPrerenderer(calls: StubCall[]): DiagramPrerenderer {
    return async (sources, options) => {
      calls.push({ sources: sources.map((s) => ({ ...s })), options });
      return {
        svgs: new Map(
          sources.map((s) => [
            s.id,
            { text: s.text, svg: `<svg data-stub="${s.id}"></svg>` }
          ])
        ),
        notes: ["mermaid: stub engine"]
      };
    };
  }

  it("passes linkBase + allowedOrigins into the compiled sources and embeds the SVGs", async () => {
    const out = await newOutDir();
    const io = captureIo();
    const calls: StubCall[] = [];
    await renderToDist({
      outDir: out,
      book: fixtureBook(),
      change: fixtureChange(),
      io,
      repoOrigin: "https://github.com/acme/demo",
      headSha: HEAD_SHA,
      prerender: stubPrerenderer(calls)
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options.outDir).toBe(out);
    expect(calls[0]!.options.allowedOrigins).toEqual(["https://github.com"]);
    const architecture = calls[0]!.sources.find((s) => s.id === "architecture");
    expect(architecture).toBeDefined();
    expect(architecture!.text).toContain(
      `click n0 "https://github.com/acme/demo/blob/${HEAD_SHA}/src/orderService.ts" _blank`
    );
    const html = await readFile(join(out, "dist", "index.html"), "utf8");
    expect(html).toContain('data-stub="architecture"');
    expect(io.outText()).toContain("mermaid: stub engine");
    // A prerendered slot never carries the fallback caption.
    const archStart = html.indexOf('data-stub="architecture"');
    expect(html.slice(archStart, archStart + 400)).not.toContain(
      "built-in diagram engine"
    );
  });

  it("compiles no click directives without a repo origin or with a worktree head", async () => {
    for (const overrides of [
      { repoOrigin: null, headSha: HEAD_SHA },
      { repoOrigin: "https://github.com/acme/demo", headSha: "WORKTREE" }
    ]) {
      const out = await newOutDir();
      const calls: StubCall[] = [];
      await renderToDist({
        outDir: out,
        book: fixtureBook(),
        change: fixtureChange(),
        io: captureIo(),
        prerender: stubPrerenderer(calls),
        ...overrides
      });
      const texts = calls[0]!.sources.map((s) => s.text).join("\n");
      expect(texts).not.toContain("click ");
      expect(texts).not.toContain("https://github.com");
    }
  });
});

describe("click-through links end to end (real mermaid, narrated diagram)", () => {
  it("renders origin-validated hrefs and real mermaid structure into the book", async () => {
    const out = await newOutDir();
    const env = { GITIVIZ_REPO_ORIGIN: "https://github.com/acme/demo-shop" };
    expect(
      await runCli(
        ["compare", "main", DEMO_FEATURE_BRANCH, "--repo", demoRepo, "--out", out],
        captureIo(),
        env
      )
    ).toBe(0);
    // Narrate an architecture diagram anchored to a real evidence file, the
    // way the agent loop does.
    const request = (await readJson(join(out, "narration-request.json"))) as {
      evidenceFiles: string[];
    };
    const file = request.evidenceFiles[0]!;
    await writeFile(
      join(out, "narration-response.json"),
      JSON.stringify({
        architectureDiagram: {
          clusters: [{ id: "core", title: "Core services", tone: "blue" }],
          nodes: [
            {
              id: "svc",
              cluster: "core",
              humanLabel: "Checkout service",
              role: "order handling",
              file
            }
          ],
          edges: []
        }
      }),
      "utf8"
    );
    const io = captureIo();
    expect(await runCli(["apply-narration", "--repo", demoRepo, "--out", out], io, env)).toBe(
      0
    );
    const html = await readFile(join(out, "dist", "index.html"), "utf8");
    const encoded = file.split("/").map(encodeURIComponent).join("/");
    // Click-through href on the configured origin, pinned to the head sha.
    expect(html).toContain(
      `href="https://github.com/acme/demo-shop/blob/${featureSha}/${encoded}"`
    );
    // Real mermaid output markers: cluster group + tone class defs.
    expect(html).toContain('class="cluster');
    expect(html).toContain("toneBlue");
    // Still scriptless.
    expect(html).not.toContain("<script");
  }, 120_000);
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
