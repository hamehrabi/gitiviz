/**
 * Safe git execution.
 *
 * Git is ONLY ever invoked via execFile with an args ARRAY. Repo-derived
 * strings (refs, paths, labels) are hostile: they may only appear as
 * individual argv elements and are never concatenated into a shell command.
 */
import { execFile } from "node:child_process";

export interface GitResult {
  stdout: string;
  stderr: string;
}

/** Raised when git exits non-zero (or cannot be spawned). */
export class GitError extends Error {
  readonly args: readonly string[];
  readonly repoDir: string;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(opts: {
    repoDir: string;
    args: readonly string[];
    exitCode: number | null;
    stderr: string;
  }) {
    super(
      `git ${opts.args.join(" ")} failed in ${opts.repoDir} ` +
        `(exit ${opts.exitCode ?? "signal"}): ${opts.stderr.trim()}`
    );
    this.name = "GitError";
    this.repoDir = opts.repoDir;
    this.args = opts.args;
    this.exitCode = opts.exitCode;
    this.stderr = opts.stderr;
  }
}

/**
 * Run git with an explicit argument array in the given repo directory.
 * Rejects with GitError on non-zero exit.
 */
export function gitRaw(repoDir: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: repoDir,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
      },
      (error, stdout, stderr) => {
        if (error) {
          const exitCode =
            typeof (error as NodeJS.ErrnoException & { code?: unknown }).code ===
            "number"
              ? ((error as unknown as { code: number }).code)
              : null;
          reject(new GitError({ repoDir, args, exitCode, stderr: stderr ?? "" }));
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}
