/**
 * Repository web links — the single policy for composing click-through
 * URLs to files in the analyzed repository.
 *
 * Extracted from the mermaid compiler so the evidence "Sources" list on
 * commit pages and the mermaid `click` directives share one policy:
 *
 *   evidence-index membership → safeUrl(base) → per-segment percent-
 *   encoding → safeUrl(composed) → same-origin recheck → character audit.
 *
 * Every file path is hostile input (the analyzed repository controls it).
 * A path that fails ANY step yields `null`; callers must then render the
 * path as plain escaped text, never as a link. The returned URL is safe AS
 * A URL — it still passes through escAttr at the point of markup output.
 */

import { safeUrl } from "./escape.js";

/**
 * Web-link options threaded through RenderOptions.links (interface
 * contract with the CLI, which resolves them from the origin remote).
 */
export interface RenderLinkOptions {
  /**
   * Web URL prefix a repo file path is appended to for click-through,
   * e.g. "https://github.com/acme/demo/blob/abc123". Without it (or when
   * it fails the safeUrl allowlist) no file links are composed.
   */
  linkBase?: string;
  /**
   * The repository's web origin, e.g. "https://github.com" — issue links
   * render only when their URL's origin equals this exactly.
   */
  origin?: string;
  /** Origins allowed to use http: links (https: always allowed). */
  allowedOrigins?: readonly string[];
}

/** Inputs for composing one file URL. Structurally a subset of MermaidCompileOptions. */
export interface RepoFileUrlOptions {
  /** Web URL prefix the file is appended to; absent → no link. */
  linkBase?: string;
  /** Origins allowed to use http: (https: always passes). */
  allowedOrigins?: readonly string[];
  /**
   * Repo-relative paths that exist in the manifest's evidence index.
   * Links are composed ONLY for these files; absent → no links.
   */
  existingFiles?: ReadonlySet<string>;
}

/**
 * Compose and validate the web URL for one repository file, or null when
 * anything about it is unsafe. Each path segment percent-encodes, so no
 * file name can escape quoting contexts or change the URL's origin.
 */
export function repoFileUrl(
  file: string,
  options: RepoFileUrlOptions
): string | null {
  const { linkBase, allowedOrigins = [], existingFiles } = options;
  if (linkBase === undefined || existingFiles === undefined) return null;
  if (!existingFiles.has(file)) return null;
  const safeBase = safeUrl(linkBase, allowedOrigins);
  if (safeBase === null) return null;
  const encoded = file
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const url = safeUrl(
    `${safeBase.replace(/\/+$/, "")}/${encoded}`,
    allowedOrigins
  );
  if (url === null) return null;
  // The composed URL must stay on the configured repository origin.
  if (new URL(url).origin !== new URL(safeBase).origin) return null;
  // Belt and braces: nothing that could escape a quoted context.
  if (/["\s<>\\]/.test(url)) return null;
  return url;
}
