import { randomUUID } from 'node:crypto'

import type { Database } from 'better-sqlite3'

import type { GitRepositoryState } from '../shared/git.js'

export interface GitWorkspaceSettingsRecord {
  autoSnapshotEnabled: boolean
  error: string | null
  lastCheckedAt: number | null
  relativePath: string | null
  repoRoot: string | null
  state: GitRepositoryState
  workspaceId: string
}

export interface GitSnapshotRecord {
  branch: string | null
  changedFiles: number
  commitSha: string
  createdAt: number
  deletions: number
  error: string | null
  id: string
  insertions: number
  message: string
  parentSha: string | null
  revertedBySha: string | null
  status: string
  turnId: string | null
  workspaceId: string
}

interface SettingsRow {
  auto_snapshot: number
  error: string | null
  last_checked_at: number | null
  relative_path: string | null
  repo_root: string | null
  state: GitRepositoryState
  workspace_id: string
}

interface SnapshotRow {
  branch: string | null
  changed_files: number
  commit_sha: string
  created_at: number
  deletions: number
  error: string | null
  id: string
  insertions: number
  message: string
  parent_sha: string | null
  reverted_by_sha: string | null
  status: string
  turn_id: string | null
  workspace_id: string
}

const toSettings = (row: SettingsRow): GitWorkspaceSettingsRecord => ({
  autoSnapshotEnabled: row.auto_snapshot !== 0,
  error: row.error,
  lastCheckedAt: row.last_checked_at,
  relativePath: row.relative_path,
  repoRoot: row.repo_root,
  state: row.state,
  workspaceId: row.workspace_id,
})

const toSnapshot = (row: SnapshotRow): GitSnapshotRecord => ({
  branch: row.branch,
  changedFiles: row.changed_files,
  commitSha: row.commit_sha,
  createdAt: row.created_at,
  deletions: row.deletions,
  error: row.error,
  id: row.id,
  insertions: row.insertions,
  message: row.message,
  parentSha: row.parent_sha,
  revertedBySha: row.reverted_by_sha,
  status: row.status,
  turnId: row.turn_id,
  workspaceId: row.workspace_id,
})

export const createGitSnapshotStore = (db: Database) => {
  const getSettings = (workspaceId: string): GitWorkspaceSettingsRecord => {
    const row = db
      .prepare(
        `SELECT workspace_id, repo_root, relative_path, state, auto_snapshot,
                last_checked_at, error
         FROM git_workspace_settings WHERE workspace_id = ?`
      )
      .get(workspaceId) as SettingsRow | undefined
    return row
      ? toSettings(row)
      : {
          autoSnapshotEnabled: true,
          error: null,
          lastCheckedAt: null,
          relativePath: null,
          repoRoot: null,
          state: 'unknown',
          workspaceId,
        }
  }

  const saveDetection = (input: {
    error: string | null
    lastCheckedAt: number
    relativePath: string | null
    repoRoot: string | null
    state: GitRepositoryState
    workspaceId: string
  }) => {
    const now = Date.now()
    db.prepare(
      `INSERT INTO git_workspace_settings (
         workspace_id, repo_root, relative_path, state, auto_snapshot,
         last_checked_at, error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, COALESCE(
         (SELECT auto_snapshot FROM git_workspace_settings WHERE workspace_id = ?), 1
       ), ?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         repo_root = excluded.repo_root,
         relative_path = excluded.relative_path,
         state = excluded.state,
         last_checked_at = excluded.last_checked_at,
         error = excluded.error,
         updated_at = excluded.updated_at`
    ).run(
      input.workspaceId,
      input.repoRoot,
      input.relativePath,
      input.state,
      input.workspaceId,
      input.lastCheckedAt,
      input.error,
      now,
      now
    )
    return getSettings(input.workspaceId)
  }

  const setAutoSnapshotEnabled = (workspaceId: string, enabled: boolean) => {
    const now = Date.now()
    db.prepare(
      `INSERT INTO git_workspace_settings (
         workspace_id, state, auto_snapshot, created_at, updated_at
       ) VALUES (?, 'unknown', ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         auto_snapshot = excluded.auto_snapshot,
         updated_at = excluded.updated_at`
    ).run(workspaceId, enabled ? 1 : 0, now, now)
    return getSettings(workspaceId)
  }

  const insertSnapshot = (input: Omit<GitSnapshotRecord, 'id' | 'createdAt'>) => {
    const record: GitSnapshotRecord = {
      ...input,
      createdAt: Date.now(),
      id: randomUUID(),
    }
    db.prepare(
      `INSERT INTO git_snapshots (
         id, workspace_id, turn_id, commit_sha, parent_sha, branch, message,
         changed_files, insertions, deletions, status, error, created_at, reverted_by_sha
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.id,
      record.workspaceId,
      record.turnId,
      record.commitSha,
      record.parentSha,
      record.branch,
      record.message,
      record.changedFiles,
      record.insertions,
      record.deletions,
      record.status,
      record.error,
      record.createdAt,
      record.revertedBySha
    )
    return record
  }

  const listSnapshots = (workspaceId: string) =>
    (
      db
        .prepare(
          `SELECT id, workspace_id, turn_id, commit_sha, parent_sha, branch, message,
                  changed_files, insertions, deletions, status, error, created_at, reverted_by_sha
           FROM git_snapshots WHERE workspace_id = ? ORDER BY created_at DESC`
        )
        .all(workspaceId) as SnapshotRow[]
    ).map(toSnapshot)

  const getSnapshotBySha = (workspaceId: string, commitSha: string) => {
    const row = db
      .prepare(
        `SELECT id, workspace_id, turn_id, commit_sha, parent_sha, branch, message,
                changed_files, insertions, deletions, status, error, created_at, reverted_by_sha
         FROM git_snapshots WHERE workspace_id = ? AND commit_sha = ?`
      )
      .get(workspaceId, commitSha) as SnapshotRow | undefined
    return row ? toSnapshot(row) : null
  }

  const markReverted = (workspaceId: string, commitSha: string, revertedBySha: string) => {
    db.prepare(
      `UPDATE git_snapshots SET reverted_by_sha = ?, status = 'reverted'
       WHERE workspace_id = ? AND commit_sha = ?`
    ).run(revertedBySha, workspaceId, commitSha)
  }

  const deleteWorkspace = (workspaceId: string) => {
    db.transaction(() => {
      db.prepare('DELETE FROM git_snapshots WHERE workspace_id = ?').run(workspaceId)
      db.prepare('DELETE FROM git_workspace_settings WHERE workspace_id = ?').run(workspaceId)
    })()
  }

  return {
    getSettings,
    getSnapshotBySha,
    insertSnapshot,
    listSnapshots,
    markReverted,
    saveDetection,
    setAutoSnapshotEnabled,
    deleteWorkspace,
  }
}
