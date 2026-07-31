/**
 * Scripted git fixture repos for tests.
 *
 * All git invocations go through execFile with an args ARRAY — repo-derived
 * strings are only ever argv elements, never interpolated into a shell.
 * Tests run inside the Docker toolchain container, which has git but no
 * global git config, so user.name / user.email are set per fixture repo.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

/** Run git in a fixture repo. Args are always an array; never a shell string. */
export async function runGit(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoDir,
    windowsHide: true
  });
  return stdout;
}

/**
 * Create a fresh git repo in a temp dir and return its absolute path.
 * Deterministic: default branch is always "main"; identity is set per repo
 * (the container has no global git config). An optional scripted sequence of
 * git commands (arg arrays) runs after init.
 */
export async function makeRepo(steps: string[][] = []): Promise<string> {
  const repoDir = await mkdtemp(join(tmpdir(), "gitiviz-fixture-"));
  await runGit(repoDir, ["-c", "init.defaultBranch=main", "init"]);
  await runGit(repoDir, ["config", "user.email", "fixture@gitiviz.invalid"]);
  await runGit(repoDir, ["config", "user.name", "Gitiviz Fixture"]);
  await runGit(repoDir, ["config", "commit.gpgsign", "false"]);
  for (const args of steps) {
    await runGit(repoDir, args);
  }
  return repoDir;
}

/** Write a file (creating parent dirs), stage it, and commit it. */
export async function commitFile(
  repoDir: string,
  path: string,
  content: string,
  message: string
): Promise<void> {
  const abs = join(repoDir, path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
  await runGit(repoDir, ["add", "--", path]);
  await runGit(repoDir, ["commit", "-m", message]);
}

/** Delete a fixture repo created by makeRepo. */
export async function removeRepo(repoDir: string): Promise<void> {
  await rm(repoDir, { recursive: true, force: true });
}
