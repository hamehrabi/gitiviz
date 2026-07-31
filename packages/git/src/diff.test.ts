import { describe, it, expect, afterAll } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeRepo, commitFile, runGit, removeRepo } from "@gitiviz/test-fixtures";
import { diffRange, diffCommit, WORKTREE, type FileChange } from "./diff.js";

const SHA40 = /^[0-9a-f]{40}$/;

// Long enough content that git's rename detection (-M) always fires.
const LONG = Array.from({ length: 20 }, (_, i) => `line ${i} of stable content\n`).join("");

const repos: string[] = [];
async function repo(): Promise<string> {
  const r = await makeRepo();
  repos.push(r);
  return r;
}
afterAll(async () => {
  await Promise.all(repos.map(removeRepo));
});

const byPath = (changes: FileChange[], path: string): FileChange | undefined =>
  changes.find((c) => c.path === path);

describe("diff extraction", () => {
  it("detects added, modified, and deleted files with guarded blob hashes", async () => {
    const r = await repo();
    await commitFile(r, "keep.txt", "same\n", "c1: keep");
    await commitFile(r, "mod.txt", "v1\n", "c1: mod");
    await commitFile(r, "del.txt", "bye\n", "c1: del");
    await commitFile(r, "mod.txt", "v2\n", "c2: modify");
    await runGit(r, ["rm", "--", "del.txt"]);
    await runGit(r, ["commit", "-m", "c2: delete"]);
    await commitFile(r, "new.txt", "hello\n", "c2: add");

    const changes = await diffRange(r, "main~3", "main");

    expect(changes).toHaveLength(3);
    expect(byPath(changes, "keep.txt")).toBeUndefined();

    const added = byPath(changes, "new.txt");
    expect(added?.status).toBe("added");
    expect(added?.baseBlob).toBeUndefined();
    expect(added?.headBlob).toMatch(SHA40);

    const modified = byPath(changes, "mod.txt");
    expect(modified?.status).toBe("modified");
    expect(modified?.baseBlob).toMatch(SHA40);
    expect(modified?.headBlob).toMatch(SHA40);
    expect(modified?.baseBlob).not.toBe(modified?.headBlob);

    const deleted = byPath(changes, "del.txt");
    expect(deleted?.status).toBe("deleted");
    expect(deleted?.baseBlob).toMatch(SHA40);
    expect(deleted?.headBlob).toBeUndefined();
  });

  it("detects a pure rename (R100) with identical blobs", async () => {
    const r = await repo();
    await commitFile(r, "old.txt", LONG, "c1");
    await runGit(r, ["mv", "--", "old.txt", "new.txt"]);
    await runGit(r, ["commit", "-m", "pure rename"]);

    const changes = await diffRange(r, "main~1", "main");
    expect(changes).toHaveLength(1);
    const c = changes[0]!;
    expect(c.status).toBe("renamed");
    expect(c.oldPath).toBe("old.txt");
    expect(c.path).toBe("new.txt");
    expect(c.baseBlob).toMatch(SHA40);
    expect(c.headBlob).toBe(c.baseBlob);
  });

  it("detects a rename with edits (blobs differ)", async () => {
    const r = await repo();
    await commitFile(r, "a.txt", LONG, "c1");
    await runGit(r, ["mv", "--", "a.txt", "b.txt"]);
    await writeFile(join(r, "b.txt"), LONG + "one extra line\n", "utf8");
    await runGit(r, ["add", "--", "b.txt"]);
    await runGit(r, ["commit", "-m", "rename with edit"]);

    const changes = await diffRange(r, "main~1", "main");
    expect(changes).toHaveLength(1);
    const c = changes[0]!;
    expect(c.status).toBe("renamed");
    expect(c.oldPath).toBe("a.txt");
    expect(c.path).toBe("b.txt");
    expect(c.baseBlob).toMatch(SHA40);
    expect(c.headBlob).toMatch(SHA40);
    expect(c.baseBlob).not.toBe(c.headBlob);
  });

  it("diffs a single commit against its parent (sha~1..sha semantics)", async () => {
    const r = await repo();
    await commitFile(r, "a.txt", "one\n", "c1");
    await commitFile(r, "a.txt", "two\n", "c2");
    await commitFile(r, "a.txt", "three\n", "c3");

    const changes = await diffCommit(r, "main~1"); // c2 vs c1
    expect(changes).toHaveLength(1);
    expect(changes[0]!.path).toBe("a.txt");
    expect(changes[0]!.status).toBe("modified");
    expect(changes).toEqual(await diffRange(r, "main~2", "main~1"));
  });

  it("diffs a merge commit against its first parent", async () => {
    const r = await repo();
    await commitFile(r, "base.txt", "base\n", "c1");
    await runGit(r, ["checkout", "-b", "feature/m"]);
    await commitFile(r, "feature.txt", "feat\n", "c2");
    await runGit(r, ["checkout", "main"]);
    await commitFile(r, "main.txt", "main\n", "c3");
    await runGit(r, ["merge", "--no-ff", "-m", "merge feature", "feature/m"]);

    const changes = await diffCommit(r, "HEAD");
    // First parent is main's c3, so only the branch's file shows up.
    expect(changes.map((c) => c.path)).toEqual(["feature.txt"]);
    expect(changes[0]!.status).toBe("added");
  });

  it('compares against the dirty worktree when head is "WORKTREE"', async () => {
    const r = await repo();
    await commitFile(r, "w.txt", "committed\n", "c1");
    await writeFile(join(r, "w.txt"), "dirty\n", "utf8");

    const changes = await diffRange(r, "HEAD", WORKTREE);
    expect(changes).toHaveLength(1);
    const c = changes[0]!;
    expect(c.path).toBe("w.txt");
    expect(c.status).toBe("modified");
    expect(c.baseBlob).toMatch(SHA40);
    // Worktree content has no committed blob; the head side stays undefined.
    expect(c.headBlob).toBeUndefined();
  });

  it("round-trips hostile filenames (quotes, newlines) through -z parsing", async () => {
    const hostile = 'we"ird\nname .txt';
    const hostile2 = 'still"\nhostile.txt';
    const r = await repo();
    await commitFile(r, "seed.txt", "seed\n", "c0");
    await commitFile(r, hostile, LONG, "add hostile");

    let changes = await diffRange(r, "main~1", "main");
    expect(changes).toHaveLength(1);
    expect(changes[0]!.status).toBe("added");
    expect(changes[0]!.path).toBe(hostile);
    expect(changes[0]!.headBlob).toMatch(SHA40);

    await runGit(r, ["mv", "--", hostile, hostile2]);
    await runGit(r, ["commit", "-m", "rename hostile"]);

    changes = await diffRange(r, "main~1", "main");
    expect(changes).toHaveLength(1);
    expect(changes[0]!.status).toBe("renamed");
    expect(changes[0]!.oldPath).toBe(hostile);
    expect(changes[0]!.path).toBe(hostile2);
  });
});
