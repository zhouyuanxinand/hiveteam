import type { Database } from './sqlite.js'

export const applySchemaVersion62 = (db: Database) => {
  if (
    (db.pragma('table_info(dispatches)') as Array<{ name: string }>).some(
      (column) => column.name === 'parent_dispatch_id'
    )
  )
    return
  db.transaction(() => {
    db.exec(`
      ALTER TABLE dispatches ADD COLUMN parent_dispatch_id TEXT;
      ALTER TABLE dispatches ADD COLUMN root_dispatch_id TEXT;
      UPDATE dispatches SET root_dispatch_id=id;
      CREATE INDEX idx_dispatches_root ON dispatches(workspace_id,root_dispatch_id);
      ALTER TABLE worker_worktrees ADD COLUMN pinned_head_sha TEXT;
      CREATE TABLE team_review_requests (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        source_dispatch_id TEXT NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
        source_report_revision INTEGER NOT NULL CHECK(source_report_revision > 0),
        source_head_sha TEXT NOT NULL,
        source_base_sha TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        baseline_kind TEXT NOT NULL CHECK(baseline_kind IN ('target_head','dispatch_base')),
        focus TEXT NOT NULL,
        command_preset_id TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        reviewer_id TEXT NOT NULL UNIQUE REFERENCES workers(id) ON DELETE CASCADE,
        review_dispatch_id TEXT UNIQUE REFERENCES dispatches(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        last_error TEXT
      );
      CREATE INDEX idx_team_review_source ON team_review_requests(workspace_id,source_dispatch_id,created_at);
    `)
  }).immediate()
}
