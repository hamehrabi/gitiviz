/**
 * Hostile-repo security sweep (plan Task 21). Repo strings are attacker
 * input; this suite runs the full CLI against the hostile fixture (plus one
 * extra commit whose MESSAGE is the README's prompt-injection text, so the
 * injection rides a channel that actually reaches the narration request and
 * the HTML) and asserts:
 *
 *   - the HTML contains no unescaped <script and no javascript: hrefs
 *   - injection text reaches the narration request ONLY as JSON string data
 *   - a narration response referencing a fabricated id, or trying to attach
 *     fabricated evidence paths, is rejected loudly
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  HOSTILE_FILE,
  HOSTILE_SYMBOL,
  HOSTILE_URL,
  INJECTION_TEXT,
  makeHostileRepo,
  removeRepo,
  runGit
} from "@gitiviz/test-fixtures";
import { runCli, type CliIo } from "@gitiviz/cli";

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

let repo: string;
let out: string;
let exitCode: number;
let io: CapturedIo;
let html: string;
let requestRaw: string;

beforeAll(async () => {
  repo = await makeHostileRepo();
  // Extra commit: README edit whose commit message IS the injection text, so
  // the injection travels through commit subjects (a channel the narration
  // request really carries) as well as file content.
  const readmePath = join(repo, "README.md");
  const readme = await readFile(readmePath, "utf8");
  await writeFile(readmePath, `${readme}\n${INJECTION_TEXT}\n`, "utf8");
  await runGit(repo, ["add", "--all"]);
  await runGit(repo, ["commit", "-m", INJECTION_TEXT]);

  out = await mkdtemp(join(tmpdir(), "gitiviz-security-"));
  io = captureIo();
  // main~2..main covers both the hostile payload files and the injection commit.
  exitCode = await runCli(["compare", "main~2", "main", "--repo", repo, "--out", out], io);
  html = await readFile(join(out, "dist", "index.html"), "utf8");
  requestRaw = await readFile(join(out, "narration-request.json"), "utf8");
  return async () => {
    await removeRepo(repo);
  };
}, 120_000);

describe("security: rendered HTML stays inert", () => {
  it("CLI exits 0 on the hostile repo", () => {
    expect(exitCode, io.errText()).toBe(0);
  });

  it("contains no script tags and no unescaped hostile strings", () => {
    expect(html.toLowerCase()).not.toContain("<script");
    expect(html).not.toContain(HOSTILE_FILE);
    expect(html).not.toContain(HOSTILE_SYMBOL);
    // The XSS filename renders, but only as escaped text.
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;.ts");
  });

  it("contains no javascript: URL in any href or src", () => {
    expect(html).not.toMatch(/(?:href|src)\s*=\s*["']?\s*javascript:/i);
  });

  it("carries the prompt-injection commit as plain timeline text, unobeyed", () => {
    // The injection text is data: it appears (as inert text) and the book is
    // still a normal book around it — CSP intact, chapters intact.
    expect(html).toContain(INJECTION_TEXT);
    expect(html).not.toContain("pwned");
    expect(html).toContain("default-src 'none'");
  });
});

describe("security: narration request treats repo text as data", () => {
  it("is valid JSON that carries the injection text only inside string values", () => {
    expect(requestRaw).toContain(INJECTION_TEXT);
    const parsed: unknown = JSON.parse(requestRaw);
    // Blank out every string VALUE: no trace of the hostile strings may
    // survive in the structure (keys, numbers, layout) around them.
    const structureOnly = JSON.stringify(parsed, (_key, value) =>
      typeof value === "string" ? "" : value
    );
    for (const hostile of ["IGNORE PREVIOUS INSTRUCTIONS", HOSTILE_FILE, HOSTILE_SYMBOL, HOSTILE_URL]) {
      expect(structureOnly).not.toContain(hostile);
    }
  });
});

describe("security: fabricated narration is rejected", () => {
  it("rejects a response referencing a fabricated change-unit id", async () => {
    await writeFile(
      join(out, "narration-response.json"),
      JSON.stringify({
        changeUnits: [{ id: "unit-src/backdoor.ts", humanTitle: "Totally legitimate change" }]
      }),
      "utf8"
    );
    const attemptIo = captureIo();
    const code = await runCli(
      ["compare", "main~2", "main", "--repo", repo, "--out", out],
      attemptIo
    );
    expect(code).toBe(1);
    expect(attemptIo.errText()).toContain("unit-src/backdoor.ts");
    expect(attemptIo.errText()).toContain("allowed ids");
  }, 60_000);

  it("rejects a response trying to attach fabricated evidence paths", async () => {
    const request = JSON.parse(requestRaw) as { allowedChangeUnitIds: string[] };
    const validId = request.allowedChangeUnitIds[0]!;
    await writeFile(
      join(out, "narration-response.json"),
      JSON.stringify({
        changeUnits: [
          {
            id: validId,
            humanTitle: "x",
            evidence: [{ path: "src/backdoor.ts" }]
          }
        ]
      }),
      "utf8"
    );
    const attemptIo = captureIo();
    const code = await runCli(["apply-narration", "--out", out], attemptIo);
    expect(code).toBe(1);
    expect(attemptIo.errText()).toContain('"evidence"');
    expect(attemptIo.errText()).toContain("may not touch");
  }, 60_000);
});
