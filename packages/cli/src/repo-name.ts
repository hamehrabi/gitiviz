/**
 * Repository display-name resolution.
 *
 * The Docker launcher mounts the analyzed repo at /repo, so the directory
 * basename inside the container is always "repo" — useless as a title.
 * Resolution order (first non-empty wins):
 *
 *   1. --name flag
 *   2. GITIVIZ_REPO_NAME env (set by the launcher's Docker fallback)
 *   3. basename of the `origin` remote URL, with any trailing ".git" stripped
 *   4. basename of the repo directory
 *
 * Remote URLs are repo-controlled and therefore hostile: they are parsed
 * with plain string operations only (never a shell) and the resulting name
 * rides through manifests/renderer options inert — the renderer escapes it.
 */
import { basename, resolve } from "node:path";
import { remoteOriginUrl } from "@gitiviz/git";

/**
 * Derive a repo name from a git remote URL: the last path segment with any
 * trailing ".git" stripped. Handles both URL forms (https://host/user/repo.git)
 * and scp-like forms (git@host:user/repo.git). Returns null when the URL
 * yields no usable name.
 */
export function repoNameFromRemoteUrl(url: string): string | null {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (trimmed === "") return null;
  // Both "/" (URL paths) and ":" (scp-like) separate the final segment.
  const segment = trimmed.split(/[/:]/).pop() ?? "";
  const name = segment.replace(/\.git$/i, "").trim();
  return name === "" ? null : name;
}

export interface RepoNameInputs {
  /** The analyzed repository directory (tier 3 asks its origin, tier 4 its basename). */
  repoDir: string;
  /** --name flag value (tier 1). */
  nameFlag?: string | undefined;
  /** GITIVIZ_REPO_NAME env value (tier 2). */
  envName?: string | undefined;
}

/** Origin-URL lookup signature — injectable for unit tests. */
export type RemoteUrlLookup = (repoDir: string) => Promise<string | null>;

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** Resolve the repository display name (see module doc for the order). */
export async function resolveRepoName(
  inputs: RepoNameInputs,
  getRemoteUrl: RemoteUrlLookup = remoteOriginUrl
): Promise<string> {
  const flag = nonEmpty(inputs.nameFlag);
  if (flag !== null) return flag;
  const env = nonEmpty(inputs.envName);
  if (env !== null) return env;
  const url = await getRemoteUrl(inputs.repoDir);
  if (url !== null) {
    const fromRemote = repoNameFromRemoteUrl(url);
    if (fromRemote !== null) return fromRemote;
  }
  return basename(resolve(inputs.repoDir));
}
