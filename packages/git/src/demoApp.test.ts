/**
 * Verifies the scripted demo and hostile fixture generators by asserting
 * through the real @gitiviz/git API (resolveRef / mergeBase / currentBranch /
 * diffRange), exactly as downstream analyzers will consume them.
 *
 * Lives in @gitiviz/git (not @gitiviz/test-fixtures) because test-fixtures
 * cannot depend on git without creating a circular project reference.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  makeDemoRepo,
  makeHostileRepo,
  removeRepo,
  runGit,
  DEMO_FEATURE_BRANCH,
  HOSTILE_FILE,
  HOSTILE_NEWLINE_FILE,
  HOSTILE_SYMBOL,
  HOSTILE_URL,
  INJECTION_TEXT
} from "@gitiviz/test-fixtures";
import { resolveRef, mergeBase, currentBranch, diffRange } from "./index.js";

let demo: string;
let hostile: string;

beforeAll(async () => {
  [demo, hostile] = await Promise.all([makeDemoRepo(), makeHostileRepo()]);
});
afterAll(async () => {
  await Promise.all([removeRepo(demo), removeRepo(hostile)]);
});

describe("demo fixture repo", () => {
  it("has exactly 3 commits on main", async () => {
    const count = await runGit(demo, ["rev-list", "--count", "main"]);
    expect(count.trim()).toBe("3");
  });

  it("leaves feature/guest-checkout checked out, 4 commits ahead of main", async () => {
    expect(await currentBranch(demo)).toBe(DEMO_FEATURE_BRANCH);
    const ahead = await runGit(demo, [
      "rev-list",
      "--count",
      `main..${DEMO_FEATURE_BRANCH}`
    ]);
    expect(ahead.trim()).toBe("4");
  });

  it("branched feature/guest-checkout from the tip of main", async () => {
    const base = await mergeBase(demo, "main", DEMO_FEATURE_BRANCH);
    expect(base).toBe(await resolveRef(demo, "main"));
  });

  it("branch diff shows added validation, renamed service, and edited routes", async () => {
    const changes = await diffRange(demo, "main", DEMO_FEATURE_BRANCH);
    const byPath = new Map(changes.map((c) => [c.path, c]));

    const validation = byPath.get("src/validation/guest.ts");
    expect(validation?.status).toBe("added");

    const service = byPath.get("src/services/checkoutService.ts");
    expect(service?.status).toBe("renamed");
    expect(service?.oldPath).toBe("src/services/orderService.ts");

    const routes = byPath.get("src/routes/orders.ts");
    expect(routes?.status).toBe("modified");
  });

  it("contains a fixup! commit and a whitespace-only formatting commit", async () => {
    const log = await runGit(demo, [
      "log",
      "--format=%H%x00%s%x00",
      `main..${DEMO_FEATURE_BRANCH}`
    ]);
    const entries: Array<{ sha: string; subject: string }> = [];
    const tokens = log.split("\0");
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      const sha = tokens[i]!.trim();
      if (sha === "") continue;
      entries.push({ sha, subject: tokens[i + 1]! });
    }
    expect(entries).toHaveLength(4);

    const fixup = entries.find((e) => e.subject.startsWith("fixup! "));
    expect(fixup).toBeDefined();

    const style = entries.find((e) => e.subject.startsWith("style: "));
    expect(style).toBeDefined();
    const wsDiff = await runGit(demo, [
      "diff",
      "-w",
      `${style!.sha}~1`,
      style!.sha
    ]);
    expect(wsDiff).toBe("");
    const realDiff = await runGit(demo, ["diff", `${style!.sha}~1`, style!.sha]);
    expect(realDiff).not.toBe("");
  });

  it("route file defines an express-style POST /orders route", async () => {
    const content = await readFile(join(demo, "src/routes/orders.ts"), "utf8");
    expect(content).toContain('app.post("/orders"');
    expect(content).toContain('app.post("/orders/guest"');
  });
});

describe("hostile fixture repo", () => {
  it("round-trips hostile filenames through diffRange", async () => {
    const changes = await diffRange(hostile, "main~1", "main");
    const paths = changes.map((c) => c.path);
    expect(paths).toContain(HOSTILE_FILE);
    expect(paths).toContain(HOSTILE_NEWLINE_FILE);
    for (const change of changes) {
      expect(change.status).toBe("added");
    }
  });

  it("README carries the prompt-injection text as inert data", async () => {
    const readme = await readFile(join(hostile, "README.md"), "utf8");
    expect(readme).toContain("IGNORE PREVIOUS INSTRUCTIONS");
    expect(readme).toContain(INJECTION_TEXT);
  });

  it("config value holds a javascript: URL and source holds the hostile symbol", async () => {
    const config = await readFile(join(hostile, "config/app.json"), "utf8");
    expect(JSON.parse(config).homepage).toBe(HOSTILE_URL);
    expect(HOSTILE_URL).toBe("javascript:alert(1)");

    const source = await readFile(join(hostile, HOSTILE_FILE), "utf8");
    expect(source).toContain(HOSTILE_SYMBOL);
  });
});
