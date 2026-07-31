export { gitRaw, GitError, type GitResult } from "./exec.js";
export { resolveRef, mergeBase, currentBranch, remoteOriginUrl } from "./refs.js";
export {
  diffRange,
  diffCommit,
  parseNameStatusZ,
  WORKTREE,
  type FileChange,
  type FileChangeStatus
} from "./diff.js";
