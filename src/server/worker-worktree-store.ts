import type { Database } from 'better-sqlite3'
import type { WorkerWorktree } from '../shared/worker-worktree.js'

export const createWorkerWorktreeStore = (db: Database) => ({
  interruptPreparing() {
    db.prepare(
      "UPDATE worker_worktrees SET state = 'failed', error = ? WHERE state = 'preparing'"
    ).run(
      'Worktree preparation was interrupted. Inspect the recorded directory before creating a replacement worker.'
    )
  },
  get(workspaceId: string, workerId: string): WorkerWorktree | undefined {
    return db
      .prepare(`SELECT worker_id AS workerId, workspace_id AS workspaceId,
      repo_root AS repoRoot, checkout_path AS checkoutPath, workspace_path AS workspacePath,
      branch, target_branch AS targetBranch, base_sha AS baseSha, state, error
      FROM worker_worktrees WHERE workspace_id = ? AND worker_id = ?`)
      .get(workspaceId, workerId) as WorkerWorktree | undefined
  },
  insert(tree: WorkerWorktree) {
    db.prepare(`INSERT INTO worker_worktrees
      (worker_id, workspace_id, repo_root, checkout_path, workspace_path, branch, target_branch, base_sha, state, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      tree.workerId,
      tree.workspaceId,
      tree.repoRoot,
      tree.checkoutPath,
      tree.workspacePath,
      tree.branch,
      tree.targetBranch,
      tree.baseSha,
      tree.state,
      tree.error
    )
  },
  finish(workspaceId: string, workerId: string, error: string | null) {
    db.prepare(
      'UPDATE worker_worktrees SET state = ?, error = ? WHERE workspace_id = ? AND worker_id = ?'
    ).run(error === null ? 'ready' : 'failed', error, workspaceId, workerId)
  },
  integration(verificationId: string) {
    return db
      .prepare(
        'SELECT integrated_at AS integratedAt FROM dispatch_integrations WHERE verification_id = ?'
      )
      .get(verificationId) as { integratedAt: number } | undefined
  },
  recordIntegration(verificationId: string, targetSha: string) {
    db.prepare(`INSERT INTO dispatch_integrations (verification_id, target_sha, integrated_at)
      VALUES (?, ?, ?) ON CONFLICT(verification_id) DO NOTHING`).run(
      verificationId,
      targetSha,
      Date.now()
    )
  },
})
