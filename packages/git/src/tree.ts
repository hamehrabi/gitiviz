/**
 * Tree listing: which files REALLY exist in the repository at a revision.
 *
 * This is the reality check behind project-file anchors. A narrated diagram
 * describes the whole project, so its node anchors are legitimately paths the
 * rendered range never touched — but they must still be real. The only
 * authority on that is the repository itself, read here through the safe git
 * layer (execFile + args array, never a shell).
 *
 * Paths are hostile data: they come back NUL-separated (`-z`, so git never
 * quotes or escapes them) and repo-root relative (`--full-tree`), matching the
 * evidence paths a diff produces.
 */
import { gitRaw } from "./exec.js";
import { resolveRef } from "./refs.js";

/**
 * Cap on the paths one listing keeps. Bounded so a huge repository cannot
 * turn a membership test into unbounded memory; beyond it the extra paths are
 * simply unverifiable, which callers must treat exactly as "not verified"
 * (i.e. stay strict) rather than as permission.
 */
export const MAX_TREE_FILES = 50_000;

/**
 * Every tracked file path at `rev`, repo-root relative.
 *
 * The ref is resolved first (`resolveRef` pins it behind --end-of-options and
 * validates the sha), so a hostile ref string can never reach git as an
 * option. Throws like any other git call when the directory is not a usable
 * repository or the revision does not exist — callers must treat that as
 * "cannot verify" and keep their strict behaviour.
 */
export async function repoFilesAtRevision(
  repoDir: string,
  rev: string
): Promise<Set<string>> {
  const sha = await resolveRef(repoDir, rev);
  const { stdout } = await gitRaw(repoDir, [
    "ls-tree",
    "-r",
    "-z",
    "--name-only",
    "--full-tree",
    sha
  ]);
  const files = new Set<string>();
  for (const path of stdout.split("\0")) {
    if (path.length === 0) continue;
    files.add(path);
    if (files.size >= MAX_TREE_FILES) break;
  }
  return files;
}
