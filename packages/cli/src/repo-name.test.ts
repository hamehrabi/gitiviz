/**
 * Repository display-name resolution order:
 *   --name flag > GITIVIZ_REPO_NAME env > origin remote URL basename
 *   (".git" stripped) > directory basename.
 * The remote lookup is injected so every tier is pinned deterministically;
 * a real-repo integration check lives in compare.test.ts / tests/e2e.test.ts.
 */
import { describe, expect, it } from "vitest";
import { repoNameFromRemoteUrl, resolveRepoName } from "./repo-name.js";

const REMOTE = async () => "https://github.com/acme/from-remote.git";
const NO_REMOTE = async () => null;

describe("resolveRepoName order", () => {
  const repoDir = "/mounted/repo";

  it("1: --name flag beats env, remote, and directory", async () => {
    expect(
      await resolveRepoName(
        { repoDir, nameFlag: "from-flag", envName: "from-env" },
        REMOTE
      )
    ).toBe("from-flag");
  });

  it("2: env beats remote and directory when no flag", async () => {
    expect(
      await resolveRepoName({ repoDir, envName: "from-env" }, REMOTE)
    ).toBe("from-env");
  });

  it("3: origin remote basename beats directory when no flag/env", async () => {
    expect(await resolveRepoName({ repoDir }, REMOTE)).toBe("from-remote");
  });

  it("4: directory basename is the last resort", async () => {
    expect(await resolveRepoName({ repoDir: "/home/dev/widget-shop" }, NO_REMOTE)).toBe(
      "widget-shop"
    );
  });

  it("blank flag/env values are skipped, not used", async () => {
    expect(
      await resolveRepoName({ repoDir, nameFlag: "  ", envName: "" }, REMOTE)
    ).toBe("from-remote");
  });

  it("an unusable remote URL falls through to the directory basename", async () => {
    expect(
      await resolveRepoName({ repoDir: "/home/dev/widget-shop" }, async () => ".git")
    ).toBe("widget-shop");
  });
});

describe("repoNameFromRemoteUrl", () => {
  it("strips .git from an https URL", () => {
    expect(repoNameFromRemoteUrl("https://github.com/acme/widget-shop.git")).toBe(
      "widget-shop"
    );
  });

  it("handles scp-like ssh URLs", () => {
    expect(repoNameFromRemoteUrl("git@github.com:acme/widget-shop.git")).toBe(
      "widget-shop"
    );
  });

  it("handles URLs without .git and with trailing slashes", () => {
    expect(repoNameFromRemoteUrl("https://gitlab.com/team/widget-shop/")).toBe(
      "widget-shop"
    );
  });

  it("handles local path remotes", () => {
    expect(repoNameFromRemoteUrl("/srv/git/widget-shop.git")).toBe("widget-shop");
  });

  it("returns null when nothing usable remains", () => {
    expect(repoNameFromRemoteUrl("")).toBeNull();
    expect(repoNameFromRemoteUrl("   ")).toBeNull();
    expect(repoNameFromRemoteUrl(".git")).toBeNull();
  });
});
