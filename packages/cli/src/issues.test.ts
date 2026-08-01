/**
 * Defensive-reader tests for issues.json. The file normally comes from the
 * launcher's `gh issue list` run, but the out dir lives inside the analyzed
 * repository — so a hostile repo can COMMIT one. Every malformed shape must
 * degrade to null / dropped entries, never to a throw.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readIssues, type RepoIssue } from "./issues.js";

async function outDirWith(content: string | null): Promise<string> {
  const out = await mkdtemp(join(tmpdir(), "gitiviz-issues-"));
  if (content !== null) {
    await writeFile(join(out, "issues.json"), content, "utf8");
  }
  return out;
}

const VALID: RepoIssue = {
  number: 12,
  title: "Guest checkout drops the cart",
  state: "OPEN",
  url: "https://github.com/acme/demo/issues/12",
  createdAt: "2026-07-30T10:00:00Z"
};

describe("readIssues", () => {
  it("returns the issues from a well-formed file, order preserved", async () => {
    const second = { ...VALID, number: 7, title: "Second" };
    const out = await outDirWith(JSON.stringify([VALID, second]));
    expect(await readIssues(out)).toEqual([VALID, second]);
  });

  it("returns [] for an empty list (an honest 'no tickets yet')", async () => {
    const out = await outDirWith("[]");
    expect(await readIssues(out)).toEqual([]);
  });

  it("returns null when the file is absent", async () => {
    expect(await readIssues(await outDirWith(null))).toBeNull();
  });

  it("returns null for unparseable JSON and non-array roots", async () => {
    expect(await readIssues(await outDirWith("{ nope"))).toBeNull();
    expect(await readIssues(await outDirWith('{"issues": []}'))).toBeNull();
    expect(await readIssues(await outDirWith('"just a string"'))).toBeNull();
    expect(await readIssues(await outDirWith("42"))).toBeNull();
  });

  it("returns null for an oversized file instead of reading it", async () => {
    const huge = JSON.stringify([{ ...VALID, title: "x".repeat(1_100_000) }]);
    expect(await readIssues(await outDirWith(huge))).toBeNull();
  });

  it("drops entries with missing or mistyped fields, keeping the good ones", async () => {
    const out = await outDirWith(
      JSON.stringify([
        "garbage",
        null,
        [],
        { ...VALID, number: "12" },
        { ...VALID, number: 1.5 },
        { ...VALID, number: 0 },
        { ...VALID, number: -3 },
        { ...VALID, number: 2_000_000_000 },
        { ...VALID, title: 42 },
        { ...VALID, title: "" },
        { ...VALID, state: null },
        { ...VALID, url: 7 },
        { ...VALID, url: `https://a.example/${"x".repeat(2000)}` },
        { ...VALID, createdAt: 20260730 },
        { title: "no number", state: "open", url: "https://a", createdAt: "t" },
        VALID
      ])
    );
    expect(await readIssues(out)).toEqual([VALID]);
  });

  it("truncates over-long titles, states, and dates instead of dropping them", async () => {
    const out = await outDirWith(
      JSON.stringify([
        {
          ...VALID,
          title: "T".repeat(600),
          state: "s".repeat(80),
          createdAt: `2026-07-30${"z".repeat(200)}`
        }
      ])
    );
    const issues = await readIssues(out);
    expect(issues).toHaveLength(1);
    expect(issues![0]!.title).toBe("T".repeat(500));
    expect(issues![0]!.state).toBe("s".repeat(50));
    expect(issues![0]!.createdAt).toHaveLength(100);
    expect(issues![0]!.createdAt.startsWith("2026-07-30")).toBe(true);
  });

  it("caps the list at 200 surviving entries", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      ...VALID,
      number: i + 1
    }));
    const issues = await readIssues(await outDirWith(JSON.stringify(many)));
    expect(issues).toHaveLength(200);
    expect(issues![0]!.number).toBe(1);
    expect(issues![199]!.number).toBe(200);
  });

  it("keeps ONLY the five contract fields — extra keys never survive", async () => {
    // Literal JSON so "__proto__" is a real key in the parsed input (an
    // object-literal __proto__ would silently set the prototype instead).
    const raw =
      '[{"number":12,"title":"Guest checkout drops the cart","state":"OPEN",' +
      '"url":"https://github.com/acme/demo/issues/12",' +
      '"createdAt":"2026-07-30T10:00:00Z",' +
      '"body":"<script>alert(1)</script>","__proto__":{"evil":1}}]';
    const issues = await readIssues(await outDirWith(raw));
    expect(issues).toEqual([VALID]);
    expect(Object.keys(issues![0]!).sort()).toEqual([
      "createdAt",
      "number",
      "state",
      "title",
      "url"
    ]);
  });
});
