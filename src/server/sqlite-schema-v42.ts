import type { Database } from 'better-sqlite3'

export const applySchemaVersion42 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_branch_updates (
      worker_id TEXT PRIMARY KEY REFERENCES worker_worktrees(worker_id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL,
      source_sha TEXT NOT NULL, target_sha TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('running', 'conflicted', 'failed', 'complete', 'aborted')),
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS worktree_resources (
      worker_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workspace_name TEXT NOT NULL,
      repo_root TEXT NOT NULL, checkout_path TEXT NOT NULL, workspace_path TEXT NOT NULL,
      branch TEXT NOT NULL, target_branch TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'retained' CHECK(state IN ('retained', 'removing', 'removed')),
      error TEXT
    );
    INSERT OR IGNORE INTO worktree_resources
      (worker_id, workspace_id, workspace_name, repo_root, checkout_path, workspace_path, branch, target_branch)
      SELECT t.worker_id, t.workspace_id, w.name, t.repo_root, t.checkout_path, t.workspace_path, t.branch, t.target_branch
      FROM worker_worktrees t JOIN workspaces w ON w.id = t.workspace_id;
  `)
}
