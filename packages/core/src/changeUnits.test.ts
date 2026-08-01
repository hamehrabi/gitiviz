import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Entity } from "@gitiviz/schema";
import {
  DEMO_FEATURE_BRANCH,
  commitFile,
  makeDemoRepo,
  makeRepo,
  removeRepo,
  runGit
} from "@gitiviz/test-fixtures";
import { buildChangeUnits } from "./changeUnits.js";

const derivedEntity = (id: string, paths: string[]): Entity => ({
  id,
  kind: "file",
  humanLabel: id,
  baseState: "changed",
  headState: "changed",
  provenance: "derived",
  evidence: paths.map((path) => ({ path }))
});

describe("buildChangeUnits on the demo fixture branch", () => {
  let repoDir: string;

  beforeAll(async () => {
    repoDir = await makeDemoRepo();
  });
  afterAll(async () => {
    await removeRepo(repoDir);
  });

  it("produces one unit per commit, oldest first, with derived titles", async () => {
    const { changeUnits } = await buildChangeUnits({
      repoDir,
      baseRef: "main",
      headRef: DEMO_FEATURE_BRANCH
    });
    expect(changeUnits.map((u) => u.technicalTitle)).toEqual([
      "feat: add guest checkout route with validation",
      "refactor: rename order service to checkout service",
      "fixup! feat: add guest checkout route with validation",
      "style: reformat orders routes"
    ]);
    for (const unit of changeUnits) {
      expect(unit.provenance).toBe("derived");
      expect(unit.commits).toHaveLength(1);
      expect(unit.commits![0]).toMatch(/^[0-9a-f]{40}$/);
      // Narration slots stay empty for the narrator.
      expect(unit.humanTitle).toBeNull();
      expect(unit.summary ?? null).toBeNull();
    }
  });

  it("leaves the two meaningful commits ungrouped", async () => {
    const { changeUnits } = await buildChangeUnits({
      repoDir,
      baseRef: "main",
      headRef: DEMO_FEATURE_BRANCH
    });
    expect(changeUnits[0]!.grouped).toBeUndefined();
    expect(changeUnits[1]!.grouped).toBeUndefined();
  });

  it("groups the fixup! commit with a reason", async () => {
    const { changeUnits } = await buildChangeUnits({
      repoDir,
      baseRef: "main",
      headRef: DEMO_FEATURE_BRANCH
    });
    const fixup = changeUnits[2]!;
    expect(fixup.grouped).toBe(true);
    expect(fixup.groupedReason).toMatch(/fixup/i);
  });

  it("groups the whitespace-only formatting commit with a reason", async () => {
    const { changeUnits } = await buildChangeUnits({
      repoDir,
      baseRef: "main",
      headRef: DEMO_FEATURE_BRANCH
    });
    const formatting = changeUnits[3]!;
    expect(formatting.grouped).toBe(true);
    expect(formatting.groupedReason).toMatch(/whitespace/i);
  });

  it("attaches entities to the commits that touched their evidence paths", async () => {
    const guest = derivedEntity("guest-entity", ["src/validation/guest.ts"]);
    const service = derivedEntity("service-entity", [
      "src/services/orderService.ts",
      "src/services/checkoutService.ts"
    ]);
    const untouched = derivedEntity("schema-entity", ["src/db/schema.sql"]);

    const { changeUnits } = await buildChangeUnits({
      repoDir,
      baseRef: "main",
      headRef: DEMO_FEATURE_BRANCH,
      entities: [guest, service, untouched]
    });

    // Commit 1 adds the validation module; commit 2 renames the service.
    expect(changeUnits[0]!.entities).toContain("guest-entity");
    expect(changeUnits[0]!.entities).not.toContain("service-entity");
    expect(changeUnits[1]!.entities).toContain("service-entity");
    // schema.sql is untouched on the branch: attached nowhere.
    for (const unit of changeUnits) {
      expect(unit.entities).not.toContain("schema-entity");
    }
  });

  it("persists sorted touched paths as evidence on non-grouped units", async () => {
    const { changeUnits } = await buildChangeUnits({
      repoDir,
      baseRef: "main",
      headRef: DEMO_FEATURE_BRANCH
    });
    // Commit 1 adds the validation module and edits the routes file.
    expect(changeUnits[0]!.evidence?.map((anchor) => anchor.path)).toEqual([
      "src/routes/orders.ts",
      "src/validation/guest.ts"
    ]);
  });

  it("records BOTH sides of a rename as evidence", async () => {
    const { changeUnits } = await buildChangeUnits({
      repoDir,
      baseRef: "main",
      headRef: DEMO_FEATURE_BRANCH
    });
    // Commit 2 renames orderService -> checkoutService and edits the routes.
    expect(changeUnits[1]!.evidence?.map((anchor) => anchor.path)).toEqual([
      "src/routes/orders.ts",
      "src/services/checkoutService.ts",
      "src/services/orderService.ts"
    ]);
  });

  it("gives grouped units no evidence", async () => {
    const { changeUnits } = await buildChangeUnits({
      repoDir,
      baseRef: "main",
      headRef: DEMO_FEATURE_BRANCH
    });
    // The fixup! and whitespace-only commits have no chapter, so no Sources.
    expect(changeUnits[2]!.evidence).toBeUndefined();
    expect(changeUnits[3]!.evidence).toBeUndefined();
  });

  it("is deterministic: same input, same units and ids", async () => {
    const input = { repoDir, baseRef: "main", headRef: DEMO_FEATURE_BRANCH };
    const first = await buildChangeUnits(input);
    const second = await buildChangeUnits(input);
    expect(second).toEqual(first);
  });

  it("returns no units for an empty range", async () => {
    const { changeUnits } = await buildChangeUnits({
      repoDir,
      baseRef: "main",
      headRef: "main"
    });
    expect(changeUnits).toEqual([]);
  });
});

describe("buildChangeUnits classification of merges and squash! commits", () => {
  it("groups merge commits with a reason", async () => {
    const repoDir = await makeRepo();
    try {
      await commitFile(repoDir, "a.txt", "a\n", "base commit");
      await runGit(repoDir, ["checkout", "-b", "topic"]);
      await commitFile(repoDir, "b.txt", "b\n", "feat: topic work");
      await runGit(repoDir, ["checkout", "main"]);
      await commitFile(repoDir, "c.txt", "c\n", "feat: mainline work");
      await runGit(repoDir, ["merge", "--no-ff", "--no-edit", "topic"]);

      const { changeUnits } = await buildChangeUnits({
        repoDir,
        baseRef: "main~2",
        headRef: "main"
      });
      const merge = changeUnits.find((u) => u.technicalTitle.startsWith("Merge"));
      expect(merge).toBeDefined();
      expect(merge!.grouped).toBe(true);
      expect(merge!.groupedReason).toMatch(/merge/i);
      const meaningful = changeUnits.filter((u) => u.grouped !== true);
      expect(meaningful.map((u) => u.technicalTitle).sort()).toEqual([
        "feat: mainline work",
        "feat: topic work"
      ]);
    } finally {
      await removeRepo(repoDir);
    }
  });

  it("groups squash! commits with a reason", async () => {
    const repoDir = await makeRepo();
    try {
      await commitFile(repoDir, "a.txt", "a\n", "base commit");
      await commitFile(repoDir, "a.txt", "aa\n", "squash! base commit");

      const { changeUnits } = await buildChangeUnits({
        repoDir,
        baseRef: "main~1",
        headRef: "main"
      });
      expect(changeUnits).toHaveLength(1);
      expect(changeUnits[0]!.grouped).toBe(true);
      expect(changeUnits[0]!.groupedReason).toMatch(/squash/i);
    } finally {
      await removeRepo(repoDir);
    }
  });
});

describe("buildChangeUnits evidence cap on huge commits", () => {
  it("caps evidence at 500 sorted paths and records an honest limitation", async () => {
    const repoDir = await makeRepo();
    try {
      await commitFile(repoDir, "a.txt", "a\n", "base commit");
      // One commit touching 501 files, zero-padded so sort order is obvious.
      for (let i = 0; i <= 500; i += 1) {
        const path = join(repoDir, "files", `${String(i).padStart(4, "0")}.txt`);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${i}\n`, "utf8");
      }
      await runGit(repoDir, ["add", "--all"]);
      await runGit(repoDir, ["commit", "-m", "feat: many files"]);

      const { changeUnits, analysisLimitations } = await buildChangeUnits({
        repoDir,
        baseRef: "main~1",
        headRef: "main"
      });
      expect(changeUnits).toHaveLength(1);
      const paths = changeUnits[0]!.evidence!.map((anchor) => anchor.path);
      expect(paths).toHaveLength(500);
      expect(paths[0]).toBe("files/0000.txt");
      expect(paths[499]).toBe("files/0499.txt");
      expect(paths).not.toContain("files/0500.txt");
      const capNote = analysisLimitations.find((l) => l.message.includes("501 paths"));
      expect(capNote, JSON.stringify(analysisLimitations)).toBeDefined();
      expect(capNote!.message).toContain("500");
    } finally {
      await removeRepo(repoDir);
    }
  }, 120_000);
});
