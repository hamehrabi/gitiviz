/**
 * Structural + behavioral validation of the auto-story hook:
 * `plugins/claude-code/hooks/hooks.json` (PostToolUse on Bash) and the
 * extensionless `on-commit` script it runs. The hook must be a strict no-op
 * (exit 0, no output) outside a repo that opted into gitiviz, and must
 * refresh facts + emit additionalContext after a `git commit` inside one.
 */
import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { commitFile, makeRepo, removeRepo, runGit } from "@gitiviz/test-fixtures";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const hooksJsonPath = join(repoRoot, "plugins", "claude-code", "hooks", "hooks.json");
const onCommitPath = join(repoRoot, "plugins", "claude-code", "hooks", "on-commit");

interface HookEntry {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
}

function loadHooksJson(): { description?: string; hooks?: Record<string, HookEntry[]> } {
  return JSON.parse(readFileSync(hooksJsonPath, "utf8"));
}

describe("plugins/claude-code/hooks/hooks.json", () => {
  it("is valid JSON in the plugin wrapper format with a PostToolUse Bash matcher", () => {
    const config = loadHooksJson();
    expect(config.hooks, "hooks.json needs a top-level hooks wrapper").toBeTruthy();
    const postToolUse = config.hooks?.PostToolUse;
    expect(Array.isArray(postToolUse)).toBe(true);
    expect(postToolUse).toHaveLength(1);
    expect(postToolUse![0]!.matcher).toBe("Bash");
  });

  it("runs the extensionless on-commit script exec-form via ${CLAUDE_PLUGIN_ROOT}", () => {
    const entry = loadHooksJson().hooks!.PostToolUse![0]!;
    expect(entry.hooks).toHaveLength(1);
    const hook = entry.hooks![0]!;
    expect(hook.type).toBe("command");
    // Exec-form: the bare script path, no shell wrapper like `bash …`.
    expect(hook.command).toBe(
      "${CLAUDE_PLUGIN_ROOT}/plugins/claude-code/hooks/on-commit"
    );
    expect(typeof hook.timeout).toBe("number");
    expect(hook.timeout!).toBeLessThanOrEqual(30);
  });

  it("is wired up in plugin.json and every referenced path exists", () => {
    const pluginJson = JSON.parse(
      readFileSync(join(repoRoot, ".claude-plugin", "plugin.json"), "utf8")
    ) as { hooks?: string };
    expect(pluginJson.hooks).toBe("./plugins/claude-code/hooks/hooks.json");
    accessSync(hooksJsonPath, constants.R_OK);
    accessSync(onCommitPath, constants.R_OK);
  });
});

describe("plugins/claude-code/hooks/on-commit", () => {
  it("is an executable, extensionless bash script", () => {
    const stat = statSync(onCommitPath);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o111, "on-commit must be executable").not.toBe(0);
    expect(onCommitPath.endsWith(".sh")).toBe(false);
    expect(readFileSync(onCommitPath, "utf8").startsWith("#!/usr/bin/env bash")).toBe(true);
  });

  async function runHookWithStdin(
    cwd: string,
    hookInput: unknown
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolvePromise) => {
      const child = execFile(
        "bash",
        [onCommitPath],
        { cwd, maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const code = error ? ((error as { code?: number }).code ?? 1) : 0;
          resolvePromise({ code, stdout, stderr });
        }
      );
      child.stdin!.end(JSON.stringify(hookInput));
    });
  }

  const commitInput = {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: 'git commit -m "feat: something"' }
  };

  it("is a silent no-op when the cwd has no .gitiviz/", async () => {
    const repo = await makeRepo();
    try {
      await commitFile(repo, "a.txt", "a\n", "chore: a");
      const result = await runHookWithStdin(repo, commitInput);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("");
    } finally {
      await removeRepo(repo);
    }
  }, 30_000);

  it("is a silent no-op for non-commit Bash commands even with .gitiviz/ present", async () => {
    const repo = await makeRepo();
    try {
      await commitFile(repo, "a.txt", "a\n", "chore: a");
      await mkdir(join(repo, ".gitiviz"), { recursive: true });
      const result = await runHookWithStdin(repo, {
        ...commitInput,
        tool_input: { command: "git status" }
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("");
    } finally {
      await removeRepo(repo);
    }
  }, 30_000);

  it("refreshes facts for HEAD and emits additionalContext after a git commit", async () => {
    const repo = await makeRepo();
    try {
      await commitFile(repo, "package.json", '{"name":"hook-fixture"}\n', "chore: scaffold");
      await mkdir(join(repo, ".gitiviz"), { recursive: true });
      // A stale response from an earlier narration must not wedge the refresh.
      await writeFile(
        join(repo, ".gitiviz", "narration-response.json"),
        JSON.stringify({ changeUnits: [{ id: "stale-unit", humanTitle: "old" }] }),
        "utf8"
      );
      await commitFile(repo, "src/index.ts", 'export const x = 1;\n', "feat: add x");
      const headSha = (await runGit(repo, ["rev-parse", "HEAD"])).trim();

      const result = await runHookWithStdin(repo, commitInput);
      expect(result.code, result.stderr).toBe(0);

      const output = JSON.parse(result.stdout) as {
        hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
      };
      expect(output.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
      const context = output.hookSpecificOutput?.additionalContext ?? "";
      expect(context).toContain("narration-request.json");
      expect(context).toContain("narration-response.json");
      expect(context).toContain("apply-narration");

      const change = JSON.parse(
        await readFile(join(repo, ".gitiviz", "manifests", "change.json"), "utf8")
      ) as { headRevision: string };
      expect(change.headRevision).toBe(headSha);
    } finally {
      await removeRepo(repo);
    }
  }, 60_000);
});
