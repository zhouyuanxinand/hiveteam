import type { Database } from 'better-sqlite3'

export interface WorktreeResource {
  workerId: string
  workspaceId: string
  workspaceName: string
  repoRoot: string
  checkoutPath: string
  workspacePath: string
  branch: string
  targetBranch: string
  state: 'retained' | 'removing' | 'removed'
  error: string | null
}
const select = `SELECT r.worker_id AS workerId, r.workspace_id AS workspaceId,
  r.workspace_name AS workspaceName, r.repo_root AS repoRoot, r.checkout_path AS checkoutPath,
  r.workspace_path AS workspacePath, r.branch, r.target_branch AS targetBranch, r.state, r.error
  FROM worktree_resources r`
const orphaned =
  " WHERE state <> 'removed' AND NOT EXISTS (SELECT 1 FROM worker_worktrees t WHERE t.worker_id = r.worker_id)"
export const createWorktreeResourceStore = (db: Database) => ({
  get(id: string) {
    return db.prepare(`${select} WHERE worker_id = ?`).get(id) as WorktreeResource | undefined
  },
  isBound(id: string) {
    return !!db.prepare('SELECT 1 FROM worker_worktrees WHERE worker_id = ?').get(id)
  },
  list(limit: number, offset: number) {
    return {
      total: (
        db.prepare(`SELECT COUNT(*) AS total FROM worktree_resources r${orphaned}`).get() as {
          total: number
        }
      ).total,
      items: db
        .prepare(`${select + orphaned} ORDER BY workspace_name, worker_id LIMIT ? OFFSET ?`)
        .all(limit, offset) as WorktreeResource[],
    }
  },
  save(id: string, state: WorktreeResource['state'], error: string | null = null) {
    db.prepare('UPDATE worktree_resources SET state = ?, error = ? WHERE worker_id = ?').run(
      state,
      error,
      id
    )
  },
})
