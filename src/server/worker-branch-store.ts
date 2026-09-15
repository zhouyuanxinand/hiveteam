import type { Database } from 'better-sqlite3'

export interface WorkerBranchUpdate {
  workerId: string
  workspaceId: string
  sourceSha: string
  targetSha: string
  state: 'running' | 'conflicted' | 'failed' | 'complete' | 'aborted'
  error: string | null
}
export const createWorkerBranchStore = (db: Database) => ({
  get(workspaceId: string, workerId: string) {
    return db
      .prepare(`SELECT worker_id AS workerId, workspace_id AS workspaceId,
      source_sha AS sourceSha, target_sha AS targetSha, state, error
      FROM worker_branch_updates WHERE workspace_id = ? AND worker_id = ?`)
      .get(workspaceId, workerId) as WorkerBranchUpdate | undefined
  },
  save(value: WorkerBranchUpdate) {
    db.prepare(`INSERT INTO worker_branch_updates (worker_id, workspace_id, source_sha, target_sha, state, error)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(worker_id) DO UPDATE SET source_sha = excluded.source_sha,
      target_sha = excluded.target_sha, state = excluded.state, error = excluded.error`).run(
      value.workerId,
      value.workspaceId,
      value.sourceSha,
      value.targetSha,
      value.state,
      value.error
    )
  },
})
