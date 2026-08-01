import { describe, expect, it } from "vitest";
import { repoFileUrl } from "./links.js";

const BASE = "https://github.com/acme/demo/blob/abc123";

function options(overrides: Parameters<typeof repoFileUrl>[1] = {}) {
  return {
    linkBase: BASE,
    existingFiles: new Set(["src/app.ts", "dir with space/a\"b.ts"]),
    ...overrides
  };
}

describe("repoFileUrl", () => {
  it("composes the blob URL for a file in the evidence index", () => {
    expect(repoFileUrl("src/app.ts", options())).toBe(
      `${BASE}/src/app.ts`
    );
  });

  it("trims trailing slashes off the base before composing", () => {
    expect(repoFileUrl("src/app.ts", options({ linkBase: `${BASE}///` }))).toBe(
      `${BASE}/src/app.ts`
    );
  });

  it("returns null for files outside the evidence index", () => {
    expect(repoFileUrl("etc/passwd", options())).toBeNull();
  });

  it("returns null without a linkBase or without an evidence index", () => {
    expect(
      repoFileUrl("src/app.ts", { existingFiles: new Set(["src/app.ts"]) })
    ).toBeNull();
    expect(repoFileUrl("src/app.ts", { linkBase: BASE })).toBeNull();
  });

  it("percent-encodes every path segment so hostile names stay inert", () => {
    expect(repoFileUrl('dir with space/a"b.ts', options())).toBe(
      `${BASE}/dir%20with%20space/a%22b.ts`
    );
  });

  it("rejects non-https bases unless the origin is explicitly allowed", () => {
    const httpBase = "http://git.internal/acme/demo/blob/abc123";
    const files = new Set(["src/app.ts"]);
    expect(
      repoFileUrl("src/app.ts", { linkBase: httpBase, existingFiles: files })
    ).toBeNull();
    expect(
      repoFileUrl("src/app.ts", {
        linkBase: httpBase,
        existingFiles: files,
        allowedOrigins: ["http://git.internal"]
      })
    ).toBe(`${httpBase}/src/app.ts`);
  });

  it("rejects javascript: and malformed bases outright", () => {
    const files = new Set(["src/app.ts"]);
    expect(
      repoFileUrl("src/app.ts", {
        linkBase: "javascript:alert(1)//",
        existingFiles: files
      })
    ).toBeNull();
    expect(
      repoFileUrl("src/app.ts", { linkBase: "not a url", existingFiles: files })
    ).toBeNull();
  });

  it("keeps the composed URL on the base's origin under traversal attempts", () => {
    const hostile = "../../../evil.example/x";
    const url = repoFileUrl(
      hostile,
      options({ existingFiles: new Set([hostile]) })
    );
    // Either refused, or still on the repository origin — never elsewhere.
    if (url !== null) {
      expect(new URL(url).origin).toBe("https://github.com");
    }
  });

  it("is deterministic", () => {
    expect(repoFileUrl("src/app.ts", options())).toBe(
      repoFileUrl("src/app.ts", options())
    );
  });
});
