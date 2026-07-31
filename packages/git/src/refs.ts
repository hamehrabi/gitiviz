/**
 * Ref resolution on top of gitRaw. Works in repos with no remote and no
 * global git config. Ref strings are hostile: they are passed as single
 * argv elements behind --end-of-options so they can never be parsed as
 * git options.
 */
import { GitError, gitRaw } from "./exec.js";

const SHA40 = /^[0-9a-f]{40}$/;

/**
 * Resolve any ref-ish string (branch, tag, sha, HEAD, main~1, ...) to a
 * full 40-char commit sha. Throws a clear Error for unknown refs.
 */
export async function resolveRef(repoDir: string, ref: string): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await gitRaw(repoDir, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`
    ]));
  } catch (cause) {
    throw new Error(
      `Unknown git ref "${ref}" in repository ${repoDir}. ` +
        `Expected a branch, tag, or commit sha that exists locally.`,
      { cause }
    );
  }
  const sha = stdout.trim();
  if (!SHA40.test(sha)) {
    throw new Error(`git rev-parse returned an unexpected value for "${ref}": ${sha}`);
  }
  return sha;
}

/** Merge base of two refs (each resolved and validated first). */
export async function mergeBase(
  repoDir: string,
  refA: string,
  refB: string
): Promise<string> {
  const [shaA, shaB] = await Promise.all([
    resolveRef(repoDir, refA),
    resolveRef(repoDir, refB)
  ]);
  const { stdout } = await gitRaw(repoDir, ["merge-base", shaA, shaB]);
  return stdout.trim();
}

/**
 * URL of the `origin` remote, or null when the repo has no origin.
 * The returned string is repo-controlled and therefore hostile: callers
 * may parse it but must never pass it through a shell or emit it unescaped.
 */
export async function remoteOriginUrl(repoDir: string): Promise<string | null> {
  try {
    const { stdout } = await gitRaw(repoDir, ["remote", "get-url", "origin"]);
    const url = stdout.trim();
    return url === "" ? null : url;
  } catch (error) {
    if (error instanceof GitError) {
      return null; // no origin remote configured
    }
    throw error;
  }
}

/** Current branch name, or null when HEAD is detached. */
export async function currentBranch(repoDir: string): Promise<string | null> {
  try {
    const { stdout } = await gitRaw(repoDir, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD"
    ]);
    return stdout.trim();
  } catch (error) {
    if (error instanceof GitError && error.exitCode === 1) {
      return null; // detached HEAD
    }
    throw error;
  }
}
