import { describe, expect, it } from "vitest";
import { repoWebUrlFromRemote, resolveRepoOrigin } from "./repo-origin.js";

describe("repoWebUrlFromRemote", () => {
  it("passes https URLs through, stripping .git and trailing slashes", () => {
    expect(repoWebUrlFromRemote("https://github.com/hamehrabi/gitiviz")).toBe(
      "https://github.com/hamehrabi/gitiviz"
    );
    expect(repoWebUrlFromRemote("https://github.com/acme/demo.git")).toBe(
      "https://github.com/acme/demo"
    );
    expect(repoWebUrlFromRemote("https://github.com/acme/demo.git/")).toBe(
      "https://github.com/acme/demo"
    );
  });

  it("translates scp-like and ssh remotes to https", () => {
    expect(repoWebUrlFromRemote("git@github.com:acme/demo.git")).toBe(
      "https://github.com/acme/demo"
    );
    expect(repoWebUrlFromRemote("ssh://git@github.com/acme/demo.git")).toBe(
      "https://github.com/acme/demo"
    );
    // An ssh port is not a web port — it is dropped.
    expect(repoWebUrlFromRemote("ssh://git@git.corp:2222/team/repo.git")).toBe(
      "https://git.corp/team/repo"
    );
  });

  it("keeps http (and its port) for internal hosts", () => {
    expect(repoWebUrlFromRemote("http://git.internal:8080/team/repo.git")).toBe(
      "http://git.internal:8080/team/repo"
    );
  });

  it("drops credentials embedded in the remote URL", () => {
    expect(repoWebUrlFromRemote("https://user:secret@github.com/acme/demo.git")).toBe(
      "https://github.com/acme/demo"
    );
  });

  it("rejects unusable or hostile remotes", () => {
    expect(repoWebUrlFromRemote("")).toBeNull();
    expect(repoWebUrlFromRemote("/local/path/repo.git")).toBeNull();
    expect(repoWebUrlFromRemote("file:///local/path/repo.git")).toBeNull();
    expect(repoWebUrlFromRemote("javascript:alert(1)")).toBeNull();
    expect(repoWebUrlFromRemote("https://github.com/")).toBeNull();
    expect(repoWebUrlFromRemote("https://github.com")).toBeNull();
  });
});

describe("resolveRepoOrigin", () => {
  const noRemote = async (): Promise<string | null> => null;

  it("prefers a valid GITIVIZ_REPO_ORIGIN env value", async () => {
    const origin = await resolveRepoOrigin(
      { repoDir: "/r", envOrigin: "https://github.com/acme/demo/" },
      async () => "git@github.com:other/repo.git"
    );
    expect(origin).toBe("https://github.com/acme/demo");
  });

  it("an explicit but unusable env value yields null (no silent fallback)", async () => {
    expect(
      await resolveRepoOrigin(
        { repoDir: "/r", envOrigin: "javascript:alert(1)" },
        async () => "https://github.com/acme/demo.git"
      )
    ).toBeNull();
    expect(
      await resolveRepoOrigin(
        { repoDir: "/r", envOrigin: "not a url" },
        async () => "https://github.com/acme/demo.git"
      )
    ).toBeNull();
  });

  it("falls back to the origin remote's web form", async () => {
    const origin = await resolveRepoOrigin(
      { repoDir: "/r" },
      async () => "git@github.com:hamehrabi/gitiviz.git"
    );
    expect(origin).toBe("https://github.com/hamehrabi/gitiviz");
  });

  it("resolves to null without env or remote", async () => {
    expect(await resolveRepoOrigin({ repoDir: "/r" }, noRemote)).toBeNull();
  });

  it("swallows remote lookup failures (no origin, not an error)", async () => {
    expect(
      await resolveRepoOrigin({ repoDir: "/r" }, async () => {
        throw new Error("not a git repo");
      })
    ).toBeNull();
  });
});
