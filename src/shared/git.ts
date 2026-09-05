export type GitRepositoryState = 'unknown' | 'ready' | 'not-repository' | 'unavailable' | 'error'

export interface WorkspaceGitStatus {
  autoSnapshotEnabled: boolean
  branch: string | null
  changedFileCount: number
  checkedAt: number
  error: string | null
  headSha: string | null
  isDirty: boolean
  relativePath: string | null
  repoRoot: string | null
  stagedFileCount: number
  state: GitRepositoryState
  untrackedFileCount: number
  workspaceId: string
  workspacePath: string
}

export interface GitCommitSummary {
  authorEmail: string
  authorName: string
  authoredAt: number
  changedFiles: number
  committedAt: number
  deletions: number
  insertions: number
  isHiveTeamSnapshot: boolean
  message: string
  parents: string[]
  revertedBySha: string | null
  sha: string
  shortSha: string
  turnId: string | null
}

export interface GitCommitPage {
  commits: GitCommitSummary[]
  hasMore: boolean
  offset: number
  limit: number
}

export type GitSnapshotOutcome = 'created' | 'no_changes'

export interface GitSnapshotResult {
  changedFiles: number
  commit: GitCommitSummary | null
  deletions: number
  insertions: number
  outcome: GitSnapshotOutcome
}

export interface GitRevertResult {
  commit: GitCommitSummary
  revertedSha: string
}

/**
 * Working-tree changes relative to the commit recorded when a dispatch was
 * created. `untrackedFiles` are listed separately because they have no blob
 * in the baseline commit and therefore never appear in `patch`.
 */
export interface WorkspaceDispatchDiff {
  baseSha: string
  headSha: string | null
  patch: string
  truncated: boolean
  untrackedFiles: string[]
}
