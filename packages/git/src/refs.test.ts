import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeRepo, commitFile, runGit, removeRepo } from "@gitiviz/test-fixtures";
import { resolveRef, mergeBase, currentBranch, remoteOriginUrl } from "./refs.js";

const SHA40 = /^[0-9a-f]{40}$/;

describe("ref resolution", () => {
  let repo: string;

  beforeAll(async () => {
    repo = await makeRepo();
    // main: c1 -- c2 -- c4
    //              \
    // feature/x:    c3
    await commitFile(repo, "a.txt", "one\n", "c1");
    await commitFile(repo, "b.txt", "two\n", "c2");
    await runGit(repo, ["checkout", "-b", "feature/x"]);
    await commitFile(repo, "c.txt", "three\n", "c3");
    await runGit(repo, ["checkout", "main"]);
    await commitFile(repo, "d.txt", "four\n", "c4");
  });

  afterAll(async () => {
    await removeRepo(repo);
  });

  it("resolves HEAD to a 40-char sha", async () => {
    const sha = await resolveRef(repo, "HEAD");
    expect(sha).toMatch(SHA40);
  });

  it("computes merge-base of branch and main", async () => {
    const mb = await mergeBase(repo, "feature/x", "main");
    const c2 = await resolveRef(repo, "main~1");
    expect(mb).toMatch(SHA40);
    expect(mb).toBe(c2);
  });

  it("throws a clear error for an unknown ref", async () => {
    await expect(resolveRef(repo, "no-such-ref")).rejects.toThrow(
      /unknown git ref "no-such-ref"/i
    );
  });

  it("does not let a hostile ref be parsed as a git option", async () => {
    await expect(resolveRef(repo, "--upload-pack=evil")).rejects.toThrow(
      /unknown git ref/i
    );
  });

  it("works in a repo with no remote", async () => {
    // This fixture never had a remote; branch + sha resolution must not
    // depend on origin existing.
    expect(await currentBranch(repo)).toBe("main");
    expect(await resolveRef(repo, "feature/x")).toMatch(SHA40);
  });

  it("returns null for currentBranch when HEAD is detached", async () => {
    const detached = await makeRepo();
    try {
      await commitFile(detached, "x.txt", "x\n", "c1");
      await runGit(detached, ["checkout", "--detach", "HEAD"]);
      expect(await currentBranch(detached)).toBeNull();
    } finally {
      await removeRepo(detached);
    }
  });

  it("remoteOriginUrl is null in a repo without an origin remote", async () => {
    expect(await remoteOriginUrl(repo)).toBeNull();
  });

  it("remoteOriginUrl returns the configured origin URL verbatim", async () => {
    const withRemote = await makeRepo();
    try {
      await commitFile(withRemote, "x.txt", "x\n", "c1");
      await runGit(withRemote, [
        "remote",
        "add",
        "origin",
        "https://github.com/acme/widget-shop.git"
      ]);
      expect(await remoteOriginUrl(withRemote)).toBe(
        "https://github.com/acme/widget-shop.git"
      );
    } finally {
      await removeRepo(withRemote);
    }
  });
});
