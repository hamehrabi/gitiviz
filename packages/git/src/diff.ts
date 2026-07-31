/**
 * Diff extraction with rename detection and worktree support.
 *
 * Output of `git diff --name-status -z -M` is parsed on NUL boundaries, so
 * hostile filenames (quotes, newlines, leading dashes) round-trip as data.
 * Git is only ever invoked through gitRaw (execFile + args array).
 */
import { gitRaw } from "./exec.js";
import { resolveRef } from "./refs.js";

/**
 * Sentinel head revision meaning "compare against the working tree
 * (tracked files, staged or not) instead of a commit".
 */
export const WORKTREE = "WORKTREE";

export type FileChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface FileChange {
  /** Head-side path (for deletions: the path that was deleted). */
  path: string;
  /** Base-side path; present only for renames. */
  oldPath?: string;
  status: FileChangeStatus;
  /** Blob sha on the base side; absent for additions. */
  baseBlob?: string;
  /** Blob sha on the head side; absent for deletions and worktree diffs. */
  headBlob?: string;
}

const SHA40 = /^[0-9a-f]{40}$/;

interface RawRecord {
  status: FileChangeStatus;
  path: string;
  oldPath?: string;
}

/**
 * Parse `git diff --name-status -z` output. Records are either
 * `STATUS NUL path NUL` or, for renames/copies, `Rnnn NUL old NUL new NUL`.
 */
export function parseNameStatusZ(stdout: string): RawRecord[] {
  const tokens = stdout.split("\0");
  if (tokens[tokens.length - 1] === "") tokens.pop();
  const records: RawRecord[] = [];
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i++]!;
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      if (oldPath === undefined || newPath === undefined) {
        throw new Error("Malformed --name-status -z output: truncated rename record");
      }
      if (letter === "R") {
        // R100 is a pure rename; lower scores are rename + edit. Either way
        // the change is a rename with old and new paths preserved.
        records.push({ status: "renamed", path: newPath, oldPath });
      } else {
        // Copy: the old path still exists, so the new path is an addition.
        records.push({ status: "added", path: newPath });
      }
    } else {
      const path = tokens[i++];
      if (path === undefined) {
        throw new Error("Malformed --name-status -z output: status without path");
      }
      const status: FileChangeStatus =
        letter === "A" ? "added" : letter === "D" ? "deleted" : "modified";
      records.push({ status, path });
    }
  }
  return records;
}

/**
 * Blob sha of `path` at commit `sha`, or undefined when that side is missing.
 * `sha` is a validated 40-hex commit, so `sha:path` can never start with "-";
 * the hostile path rides inside a single argv element.
 */
async function blobAt(
  repoDir: string,
  sha: string,
  path: string
): Promise<string | undefined> {
  try {
    const { stdout } = await gitRaw(repoDir, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${sha}:${path}`
    ]);
    const blob = stdout.trim();
    return SHA40.test(blob) ? blob : undefined;
  } catch {
    return undefined;
  }
}

/**
 * File changes between two revisions, with rename detection.
 * Pass WORKTREE as headRef to diff against the working tree (tracked files);
 * worktree content has no committed blob, so headBlob stays undefined there.
 */
export async function diffRange(
  repoDir: string,
  baseRef: string,
  headRef: string
): Promise<FileChange[]> {
  const baseSha = await resolveRef(repoDir, baseRef);
  const headSha = headRef === WORKTREE ? null : await resolveRef(repoDir, headRef);

  const args = ["diff", "--name-status", "-z", "-M", "--end-of-options", baseSha];
  if (headSha !== null) args.push(headSha);
  const { stdout } = await gitRaw(repoDir, args);

  return Promise.all(
    parseNameStatusZ(stdout).map(async (record) => {
      const change: FileChange = { path: record.path, status: record.status };
      if (record.oldPath !== undefined) change.oldPath = record.oldPath;
      if (record.status !== "added") {
        const blob = await blobAt(repoDir, baseSha, record.oldPath ?? record.path);
        if (blob !== undefined) change.baseBlob = blob;
      }
      if (record.status !== "deleted" && headSha !== null) {
        const blob = await blobAt(repoDir, headSha, record.path);
        if (blob !== undefined) change.headBlob = blob;
      }
      return change;
    })
  );
}

/**
 * File changes introduced by a single commit, diffed against its FIRST
 * parent (`sha~1..sha`) — which is also the right base for merge commits.
 */
export async function diffCommit(repoDir: string, ref: string): Promise<FileChange[]> {
  const headSha = await resolveRef(repoDir, ref);
  const baseSha = await resolveRef(repoDir, `${headSha}~1`);
  return diffRange(repoDir, baseSha, headSha);
}
