import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeRepo, commitFile, runGit, removeRepo } from "@gitiviz/test-fixtures";
import { repoFilesAtRevision } from "./tree.js";

describe("repoFilesAtRevision", () => {
  let repo: string;

  beforeAll(async () => {
    repo = await makeRepo();
    await commitFile(repo, "src/app.ts", "export const a = 1;\n", "c1");
    await commitFile(repo, "src/nested/deep/util.ts", "export const b = 2;\n", "c2");
    await commitFile(repo, "docs/read me.md", "# spaces are legal\n", "c3");
  });

  afterAll(async () => {
    await removeRepo(repo);
  });

  it("lists every tracked path at the revision, repo-root relative", async () => {
    const files = await repoFilesAtRevision(repo, "HEAD");
    expect(files.has("src/app.ts")).toBe(true);
    expect(files.has("src/nested/deep/util.ts")).toBe(true);
    // -z keeps unusual names verbatim: no quoting, no escaping.
    expect(files.has("docs/read me.md")).toBe(true);
    expect(files.size).toBe(3);
  });

  it("reads the tree of the revision asked for, not of HEAD", async () => {
    const files = await repoFilesAtRevision(repo, "HEAD~2");
    expect(files.has("src/app.ts")).toBe(true);
    expect(files.has("src/nested/deep/util.ts")).toBe(false);
  });

  it("throws for an unknown revision so callers can stay strict", async () => {
    await expect(repoFilesAtRevision(repo, "no-such-ref")).rejects.toThrow(
      /unknown git ref/i
    );
  });

  it("does not let a hostile revision be parsed as a git option", async () => {
    await expect(repoFilesAtRevision(repo, "--upload-pack=evil")).rejects.toThrow(
      /unknown git ref/i
    );
  });

  it("throws when the directory is not a repository", async () => {
    const notARepo = await makeRepo();
    await runGit(notARepo, ["init"]); // no commits at all
    await expect(repoFilesAtRevision(notARepo, "HEAD")).rejects.toThrow();
    await removeRepo(notARepo);
  });
});
