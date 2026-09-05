import type { Database } from 'better-sqlite3'

import type {
  GitCommitPage,
  GitCommitSummary,
  GitRevertResult,
  GitSnapshotResult,
  WorkspaceDispatchDiff,
  WorkspaceGitStatus,
} from '../shared/git.js'
import {
  commitGitChanges,
  detectGitRepository,
  GitCommandError,
  type getGitCommit,
  initializeGitRepository,
  isGitAncestor,
  listGitCommits,
  readGitStatus,
  readGitWorkingTreeDiff,
  revertGitCommit,
  stageGitChanges,
} from './git-command.js'
import {
  createGitSnapshotStore,
  type GitSnapshotRecord,
  type GitWorkspaceSettingsRecord,
} from './git-snapshot-store.js'

const SHA_PATTERN = /^[0-9a-f]{7,64}$/iu

const toSummary = (
  commit: Awaited<ReturnType<typeof getGitCommit>>,
  snapshot: GitSnapshotRecord | null
): GitCommitSummary => ({
  authorEmail: commit.authorEmail,
  authorName: commit.authorName,
  authoredAt: commit.authoredAt,
  changedFiles: commit.changedFiles,
  committedAt: commit.committedAt,
  deletions: commit.deletions,
  insertions: commit.insertions,
  isHiveTeamSnapshot: snapshot !== null,
  message: commit.message,
  parents: commit.parents,
  revertedBySha: snapshot?.revertedBySha ?? null,
  sha: commit.sha,
  shortSha: commit.sha.slice(0, 7),
  turnId: snapshot?.turnId ?? null,
})

const normalizeMessage = (message: string | undefined) => {
  const normalized = (message ?? 'HiveTeam: workspace snapshot').replace(/\s+/gu, ' ').trim()
  return (normalized || 'HiveTeam: workspace snapshot').slice(0, 160)
}

const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

// Git uses an index lock for mutations and Windows is much less permissive
// than POSIX when another Git process is reading that index at the same time.
// Workspace binding starts detection in the background, so serialize all Git
// operations for one workspace to prevent a background status scan from
// racing a snapshot, revert, or explicit refresh.
const createWorkspaceOperationQueue = () => {
  const pending = new Map<string, Promise<unknown>>()

  return async <T>(workspaceId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = pending.get(workspaceId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    pending.set(workspaceId, current)
    try {
      return await current
    } finally {
      if (pending.get(workspaceId) === current) pending.delete(workspaceId)
    }
  }
}

export interface GitWorkspaceService {
  createSnapshot: (input: {
    expectedHead?: string | null
    message?: string
    turnId?: string | null
    workspaceId: string
    workspacePath: string
  }) => Promise<GitSnapshotResult>
  getDispatchDiff: (
    workspaceId: string,
    workspacePath: string,
    baseSha: string,
    input?: { maxChars?: number }
  ) => Promise<WorkspaceDispatchDiff>
  /**
   * Lightweight HEAD lookup used when recording dispatch baselines. Returns
   * null when the workspace is not a usable Git repository.
   */
  getHeadSha: (workspaceId: string, workspacePath: string) => Promise<string | null>
  getStatus: (workspaceId: string, workspacePath: string) => Promise<WorkspaceGitStatus>
  initialize: (workspaceId: string, workspacePath: string) => Promise<WorkspaceGitStatus>
  listCommits: (
    workspaceId: string,
    workspacePath: string,
    input?: { limit?: number; offset?: number }
  ) => Promise<GitCommitPage>
  deleteWorkspace: (workspaceId: string) => void
  markTurnSnapshot: (workspaceId: string, commitSha: string, turnId: string) => void
  revertSnapshot: (input: {
    commitSha: string
    expectedHead?: string | null
    workspaceId: string
    workspacePath: string
  }) => Promise<GitRevertResult>
  setAutoSnapshot: (workspaceId: string, enabled: boolean) => void
}

export const createGitWorkspaceService = (db: Database): GitWorkspaceService => {
  const snapshotStore = createGitSnapshotStore(db)
  const runExclusive = createWorkspaceOperationQueue()

  const notReadyStatus = (
    workspaceId: string,
    workspacePath: string,
    settings: GitWorkspaceSettingsRecord,
    state: WorkspaceGitStatus['state'],
    error: string | null
  ): WorkspaceGitStatus => ({
    autoSnapshotEnabled: settings.autoSnapshotEnabled,
    branch: null,
    changedFileCount: 0,
    checkedAt: Date.now(),
    error,
    headSha: null,
    isDirty: false,
    relativePath: settings.relativePath,
    repoRoot: settings.repoRoot,
    stagedFileCount: 0,
    state,
    untrackedFileCount: 0,
    workspaceId,
    workspacePath,
  })

  const detect = async (workspaceId: string, workspacePath: string) => {
    try {
      const repository = await detectGitRepository(workspacePath)
      const saved = snapshotStore.saveDetection({
        error: null,
        lastCheckedAt: Date.now(),
        relativePath: repository.relativePath,
        repoRoot: repository.repoRoot,
        state: 'ready',
        workspaceId,
      })
      return { repository, settings: saved }
    } catch (error) {
      const state: WorkspaceGitStatus['state'] =
        error instanceof GitCommandError && error.kind === 'unavailable'
          ? 'unavailable'
          : error instanceof GitCommandError && error.exitCode === 128
            ? 'not-repository'
            : 'error'
      const saved = snapshotStore.saveDetection({
        error: getErrorMessage(error),
        lastCheckedAt: Date.now(),
        relativePath: null,
        repoRoot: null,
        state,
        workspaceId,
      })
      return { error, repository: null, settings: saved }
    }
  }

  const getStatusUnlocked = async (workspaceId: string, workspacePath: string) => {
    const result = await detect(workspaceId, workspacePath)
    if (!result.repository) {
      return notReadyStatus(
        workspaceId,
        workspacePath,
        result.settings,
        result.settings.state,
        result.settings.error
      )
    }
    const status = await readGitStatus(result.repository)
    return {
      autoSnapshotEnabled: result.settings.autoSnapshotEnabled,
      branch: result.repository.branch,
      changedFileCount: status.changedFileCount,
      checkedAt: Date.now(),
      error: null,
      headSha: result.repository.headSha,
      isDirty: status.isDirty,
      relativePath: result.repository.relativePath,
      repoRoot: result.repository.repoRoot,
      stagedFileCount: status.stagedFileCount,
      state: 'ready' as const,
      untrackedFileCount: status.untrackedFileCount,
      workspaceId,
      workspacePath,
    }
  }

  const createSnapshotUnlocked = async (input: {
    expectedHead?: string | null
    message?: string
    turnId?: string | null
    workspaceId: string
    workspacePath: string
  }) => {
    const result = await detect(input.workspaceId, input.workspacePath)
    if (!result.repository) {
      throw new Error(result.settings.error ?? 'Workspace is not a Git repository')
    }
    if (input.expectedHead && result.repository.headSha !== input.expectedHead) {
      throw new Error('Git HEAD changed while the HiveTeam snapshot was pending')
    }
    const stagedFiles = await stageGitChanges(result.repository)
    if (stagedFiles.length === 0) {
      return {
        changedFiles: 0,
        commit: null,
        deletions: 0,
        insertions: 0,
        outcome: 'no_changes' as const,
      }
    }
    const message = normalizeMessage(input.message)
    const commit = await commitGitChanges(result.repository, message)
    const snapshot = snapshotStore.insertSnapshot({
      branch: result.repository.branch,
      changedFiles: commit.changedFiles,
      commitSha: commit.sha,
      deletions: commit.deletions,
      error: null,
      insertions: commit.insertions,
      message: commit.message,
      parentSha: commit.parents[0] ?? null,
      revertedBySha: null,
      status: 'created',
      turnId: input.turnId ?? null,
      workspaceId: input.workspaceId,
    })
    return {
      changedFiles: commit.changedFiles,
      commit: toSummary(commit, snapshot),
      deletions: commit.deletions,
      insertions: commit.insertions,
      outcome: 'created' as const,
    }
  }

  const listCommitsUnlocked = async (
    workspaceId: string,
    workspacePath: string,
    input: { limit?: number; offset?: number } = {}
  ) => {
    const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 30)))
    const offset = Math.max(0, Math.floor(input.offset ?? 0))
    const result = await detect(workspaceId, workspacePath)
    if (!result.repository) {
      return { commits: [], hasMore: false, limit, offset }
    }
    const rawCommits = await listGitCommits(result.repository, { limit, offset })
    const snapshots = new Map(
      snapshotStore.listSnapshots(workspaceId).map((snapshot) => [snapshot.commitSha, snapshot])
    )
    return {
      commits: rawCommits
        .slice(0, limit)
        .map((commit) => toSummary(commit, snapshots.get(commit.sha) ?? null)),
      hasMore: rawCommits.length > limit,
      limit,
      offset,
    }
  }

  const getDispatchDiffUnlocked = async (
    workspaceId: string,
    workspacePath: string,
    baseSha: string,
    input: { maxChars?: number } = {}
  ): Promise<WorkspaceDispatchDiff> => {
    if (!SHA_PATTERN.test(baseSha)) throw new Error('Invalid Git commit SHA')
    const result = await detect(workspaceId, workspacePath)
    if (!result.repository) {
      throw new Error(result.settings.error ?? 'Workspace is not a Git repository')
    }
    const diff = await readGitWorkingTreeDiff(result.repository, baseSha, input)
    return {
      baseSha,
      headSha: result.repository.headSha,
      patch: diff.patch,
      truncated: diff.truncated,
      untrackedFiles: diff.untrackedFiles,
    }
  }

  const getHeadShaUnlocked = async (_workspaceId: string, workspacePath: string) => {
    // Read-only on purpose: this runs on every dispatch and must never touch
    // persisted detection state, so it cannot fail with a database error
    // after a caller closed the store while the git spawn was in flight.
    try {
      return (await detectGitRepository(workspacePath)).headSha
    } catch {
      return null
    }
  }

  const initializeUnlocked = async (workspaceId: string, workspacePath: string) => {
    const current = await detect(workspaceId, workspacePath)
    if (current.repository) return getStatusUnlocked(workspaceId, workspacePath)
    await initializeGitRepository(workspacePath)
    return getStatusUnlocked(workspaceId, workspacePath)
  }

  const revertSnapshotUnlocked = async (input: {
    commitSha: string
    expectedHead?: string | null
    workspaceId: string
    workspacePath: string
  }) => {
    if (!SHA_PATTERN.test(input.commitSha)) throw new Error('Invalid Git commit SHA')
    const target = snapshotStore.getSnapshotBySha(input.workspaceId, input.commitSha)
    if (!target) throw new Error('The selected commit is not a HiveTeam snapshot')
    const result = await detect(input.workspaceId, input.workspacePath)
    if (!result.repository)
      throw new Error(result.settings.error ?? 'Workspace is not a Git repository')
    const status = await readGitStatus(result.repository)
    if (status.isDirty)
      throw new Error('Commit or stash current workspace changes before reverting')
    if (input.expectedHead && result.repository.headSha !== input.expectedHead) {
      throw new Error('Git HEAD changed. Refresh the Git history before reverting')
    }
    if (
      !result.repository.headSha ||
      !(await isGitAncestor(result.repository, input.commitSha, result.repository.headSha))
    ) {
      throw new Error('The selected snapshot is not an ancestor of the current branch')
    }
    const revertCommit = await revertGitCommit(result.repository, input.commitSha)
    const snapshot = snapshotStore.insertSnapshot({
      branch: result.repository.branch,
      changedFiles: revertCommit.changedFiles,
      commitSha: revertCommit.sha,
      deletions: revertCommit.deletions,
      error: null,
      insertions: revertCommit.insertions,
      message: revertCommit.message,
      parentSha: revertCommit.parents[0] ?? null,
      revertedBySha: null,
      status: 'revert',
      turnId: null,
      workspaceId: input.workspaceId,
    })
    snapshotStore.markReverted(input.workspaceId, input.commitSha, revertCommit.sha)
    return {
      commit: toSummary(revertCommit, snapshot),
      revertedSha: input.commitSha,
    }
  }

  return {
    createSnapshot: (input) => runExclusive(input.workspaceId, () => createSnapshotUnlocked(input)),
    deleteWorkspace(workspaceId: string) {
      snapshotStore.deleteWorkspace(workspaceId)
    },
    getDispatchDiff: (workspaceId, workspacePath, baseSha, input) =>
      runExclusive(workspaceId, () =>
        getDispatchDiffUnlocked(workspaceId, workspacePath, baseSha, input)
      ),
    getHeadSha: (workspaceId, workspacePath) =>
      runExclusive(workspaceId, () => getHeadShaUnlocked(workspaceId, workspacePath)),
    getStatus: (workspaceId, workspacePath) =>
      runExclusive(workspaceId, () => getStatusUnlocked(workspaceId, workspacePath)),
    initialize: (workspaceId, workspacePath) =>
      runExclusive(workspaceId, () => initializeUnlocked(workspaceId, workspacePath)),
    listCommits: (workspaceId, workspacePath, input) =>
      runExclusive(workspaceId, () => listCommitsUnlocked(workspaceId, workspacePath, input)),
    markTurnSnapshot(workspaceId: string, commitSha: string, turnId: string) {
      const snapshot = snapshotStore.getSnapshotBySha(workspaceId, commitSha)
      if (!snapshot || snapshot.turnId === turnId) return
      // A manual snapshot may be associated with a turn after the terminal
      // settled event arrives. Keep this update narrow and idempotent.
      db.prepare(
        'UPDATE git_snapshots SET turn_id = ? WHERE workspace_id = ? AND commit_sha = ?'
      ).run(turnId, workspaceId, commitSha)
    },
    revertSnapshot: (input) => runExclusive(input.workspaceId, () => revertSnapshotUnlocked(input)),
    setAutoSnapshot(workspaceId: string, enabled: boolean) {
      snapshotStore.setAutoSnapshotEnabled(workspaceId, enabled)
    },
  }
}
