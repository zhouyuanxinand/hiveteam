import type { Database } from 'better-sqlite3'
import type { DispatchPullRequest } from '../shared/pull-request.js'

type Row = Omit<DispatchPullRequest, 'snapshot'> & { snapshot: string | null }
const select = `SELECT dispatch_id AS dispatchId, workspace_id AS workspaceId,
  verification_id AS verificationId, head_sha AS headSha, repository, branch,
  base_branch AS baseBranch, state, number, snapshot, error, updated_at AS updatedAt
  FROM dispatch_pull_requests`
const decode = (row: Row): DispatchPullRequest => ({
  ...row,
  snapshot: row.snapshot ? JSON.parse(row.snapshot) : null,
})

export const createPullRequestStore = (db: Database) => ({
  interruptUnfinished() {
    db.prepare(`UPDATE dispatch_pull_requests SET state = 'failed', error = ?
      WHERE state = 'publishing'`).run(
      'Publication was interrupted. The remote branch or pull request may already exist; retry to reconcile it.'
    )
  },
  get(workspaceId: string, dispatchId: string): DispatchPullRequest | null {
    const row = db
      .prepare(`${select} WHERE workspace_id = ? AND dispatch_id = ?`)
      .get(workspaceId, dispatchId) as Row | undefined
    return row ? decode(row) : null
  },
  save(value: DispatchPullRequest) {
    db.prepare(`INSERT INTO dispatch_pull_requests
      (dispatch_id, workspace_id, verification_id, head_sha, repository, branch,
       base_branch, state, number, snapshot, error, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(dispatch_id) DO UPDATE SET verification_id = excluded.verification_id,
      head_sha = excluded.head_sha, state = excluded.state, number = excluded.number,
      snapshot = excluded.snapshot, error = excluded.error, updated_at = excluded.updated_at`).run(
      value.dispatchId,
      value.workspaceId,
      value.verificationId,
      value.headSha,
      value.repository,
      value.branch,
      value.baseBranch,
      value.state,
      value.number,
      value.snapshot ? JSON.stringify(value.snapshot) : null,
      value.error,
      value.updatedAt
    )
  },
})
