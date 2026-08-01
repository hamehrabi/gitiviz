/**
 * Repository web-origin resolution — the base URL click-through links in
 * Mermaid diagrams point at (e.g. "https://github.com/acme/demo"; the
 * renderer appends "/blob/<sha>/<file>").
 *
 * Resolution order (first usable wins):
 *
 *   1. GITIVIZ_REPO_ORIGIN env — an explicit http(s) web URL. An explicit
 *      but unusable value resolves to null (no links) rather than silently
 *      falling back to the remote.
 *   2. the `origin` remote URL, translated to its https web form.
 *
 * Remote URLs are repo-controlled and therefore hostile: parsing uses the
 * URL class and plain string operations only (never a shell), and every
 * link composed from the result is re-validated by the renderer's safeUrl
 * allowlist against this origin.
 */
import { remoteOriginUrl } from "@gitiviz/git";

/** Protocols a git remote may use that map onto an https web URL. */
const REMOTE_PROTOCOLS = new Set(["http:", "https:", "ssh:", "git:", "git+ssh:"]);

/**
 * Translate a git remote URL to the repository's web URL, or null when no
 * safe translation exists. Handles URL forms (https://host/owner/repo.git,
 * ssh://git@host/owner/repo.git) and the scp-like form
 * (git@host:owner/repo.git). Credentials are dropped; ".git" is stripped;
 * http stays http (internal hosts) while every ssh/git form becomes https.
 */
export function repoWebUrlFromRemote(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed === "") return null;

  let parsed: URL;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) {
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (!REMOTE_PROTOCOLS.has(parsed.protocol)) return null;
  } else {
    // scp-like: [user@]host:path (no scheme, host may not contain "/").
    // The path must contain "/" (owner/repo shape) — that is what tells a
    // remote apart from an arbitrary "scheme:payload" string.
    const match = /^(?:[^@/\s]+@)?([^:/\s]+):([^:\s]*\/.*)$/.exec(trimmed);
    if (match === null) return null;
    try {
      parsed = new URL(`ssh://${match[1]}/${match[2]}`);
    } catch {
      return null;
    }
  }

  const host = parsed.hostname;
  if (host === "") return null;
  const path = parsed.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
  if (path === "" || path === "/") return null;

  const isHttp = parsed.protocol === "http:";
  const isWeb = isHttp || parsed.protocol === "https:";
  // A web remote's port is part of its web origin; an ssh port is not.
  const port = isWeb && parsed.port !== "" ? `:${parsed.port}` : "";
  return `${isHttp ? "http" : "https"}://${host}${port}${path}`;
}

export interface RepoOriginInputs {
  /** The analyzed repository directory (tier 2 asks its origin remote). */
  repoDir: string;
  /** GITIVIZ_REPO_ORIGIN env value (tier 1). */
  envOrigin?: string | undefined;
}

/** Origin-URL lookup signature — injectable for unit tests. */
export type RemoteUrlLookup = (repoDir: string) => Promise<string | null>;

/** Resolve the repository web origin (see module doc), or null for none. */
export async function resolveRepoOrigin(
  inputs: RepoOriginInputs,
  getRemoteUrl: RemoteUrlLookup = remoteOriginUrl
): Promise<string | null> {
  const env = inputs.envOrigin?.trim() ?? "";
  if (env !== "") {
    try {
      const parsed = new URL(env);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        const path = parsed.pathname.replace(/\/+$/, "");
        return `${parsed.origin}${path}`;
      }
    } catch {
      // fall through to the explicit-but-unusable case
    }
    return null;
  }
  let remote: string | null;
  try {
    remote = await getRemoteUrl(inputs.repoDir);
  } catch {
    return null;
  }
  return remote === null ? null : repoWebUrlFromRemote(remote);
}
