/**
 * Structural validation of the Claude Code plugin packaging:
 * `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, and the
 * slash commands in `commands/`. The repo root IS the plugin
 * (marketplace source "./"), so every `${CLAUDE_PLUGIN_ROOT}`-relative path
 * referenced by a command must exist relative to the repo root — a broken
 * reference would only surface for end users after install otherwise.
 */
import { accessSync, constants, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const commandsDir = join(repoRoot, "commands");

const pluginJson = JSON.parse(
  readFileSync(join(repoRoot, ".claude-plugin", "plugin.json"), "utf8")
) as Record<string, unknown>;
const marketplaceJson = JSON.parse(
  readFileSync(join(repoRoot, ".claude-plugin", "marketplace.json"), "utf8")
) as {
  name?: string;
  owner?: { name?: string };
  plugins?: Array<{ name?: string; source?: string }>;
};

describe(".claude-plugin/plugin.json", () => {
  it("declares name, description, author, repository, license", () => {
    expect(pluginJson.name).toBe("gitiviz");
    expect(typeof pluginJson.description).toBe("string");
    expect((pluginJson.description as string).length).toBeGreaterThan(20);
    expect((pluginJson.author as { name?: string }).name).toBeTruthy();
    expect(pluginJson.repository).toBe("https://github.com/hamehrabi/gitiviz");
    expect(pluginJson.license).toBe("MIT");
  });

  it("has no version field during active development (every commit = update)", () => {
    expect(pluginJson).not.toHaveProperty("version");
  });
});

describe(".claude-plugin/marketplace.json", () => {
  it("lists this repo root as the single plugin source", () => {
    expect(marketplaceJson.name).toBe("gitiviz");
    expect(marketplaceJson.owner?.name).toBeTruthy();
    expect(marketplaceJson.plugins).toHaveLength(1);
    expect(marketplaceJson.plugins?.[0]).toEqual({ name: "gitiviz", source: "./" });
  });

  it("marketplace plugin name matches plugin.json", () => {
    expect(marketplaceJson.plugins?.[0]?.name).toBe(pluginJson.name);
  });
});

describe("commands/", () => {
  const EXPECTED = [
    "branch.md",
    "commit.md",
    "compare.md",
    "discuss.md",
    "init.md",
    "open.md",
    "ticket.md"
  ];
  const files = readdirSync(commandsDir).filter((f) => f.endsWith(".md")).sort();

  it("contains exactly the seven slash commands", () => {
    expect(files).toEqual(EXPECTED);
  });

  describe.each(EXPECTED)("%s", (file) => {
    const source = readFileSync(join(commandsDir, file), "utf8");

    it("has YAML frontmatter with a description and allowed-tools", () => {
      const frontmatter = /^---\n([\s\S]+?)\n---\n/.exec(source);
      expect(frontmatter).not.toBeNull();
      expect(frontmatter![1]).toMatch(/^description: .+/m);
      expect(frontmatter![1]).toMatch(/^allowed-tools: \[.+\]$/m);
    });

    it("every ${CLAUDE_PLUGIN_ROOT} path it references exists in the repo", () => {
      const refs = [
        ...source.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}(\/[\w./-]+?)(?=[:"'`\s]|$)/g)
      ].map((m) => m[1]!);
      if (file !== "open.md") expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) {
        expect(() =>
          accessSync(join(repoRoot, ref), constants.R_OK)
        , `${ref} referenced by ${file} does not exist`).not.toThrow();
      }
    });

    it("pre-authorizes scripts via ${CLAUDE_PLUGIN_ROOT} in allowed-tools (ralph-wiggum pattern)", () => {
      if (file === "open.md") return; // open.md only shells out to `open`
      expect(source).toContain(
        'Bash(${CLAUDE_PLUGIN_ROOT}/plugins/claude-code/scripts/run.sh:*)'
      );
    });
  });

  describe("gh pre-authorization stays narrow", () => {
    it.each(["discuss.md", "ticket.md"])(
      "%s pre-authorizes only the two narrow gh verbs",
      (file) => {
        const source = readFileSync(join(commandsDir, file), "utf8");
        const frontmatter = /^---\n([\s\S]+?)\n---\n/.exec(source)![1]!;
        const ghAuths = [...frontmatter.matchAll(/Bash\(gh[^)]*\)/g)]
          .map((m) => m[0])
          .sort();
        expect(ghAuths).toEqual([
          "Bash(gh issue create:*)",
          "Bash(gh label create:*)"
        ]);
      }
    );

    it("no command ever pre-authorizes broad gh — Bash(gh:*) is forbidden", () => {
      for (const file of files) {
        const source = readFileSync(join(commandsDir, file), "utf8");
        expect(
          source,
          `${file} must never contain a broad Bash(gh:…) pre-authorization`
        ).not.toContain("Bash(gh:");
      }
    });
  });

  it("the launcher every command depends on is executable", () => {
    accessSync(
      join(repoRoot, "plugins", "claude-code", "scripts", "run.sh"),
      constants.X_OK
    );
  });
});
