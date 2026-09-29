import type { Database } from './sqlite.js'
export const applySchemaVersion61 = (db: Database) => {
  if (
    (db.pragma('table_info(workers)') as Array<{ name: string }>).some(
      (column) => column.name === 'retired_at'
    )
  )
    return
  db.transaction(() => {
    db.exec(`
      ALTER TABLE workers ADD COLUMN lifecycle_kind TEXT NOT NULL DEFAULT 'persistent' CHECK(lifecycle_kind IN ('persistent','ephemeral'));
      ALTER TABLE workers ADD COLUMN spawned_by_agent_id TEXT;
      ALTER TABLE workers ADD COLUMN retired_at INTEGER;
      ALTER TABLE workers ADD COLUMN preparation_state TEXT NOT NULL DEFAULT 'ready' CHECK(preparation_state IN ('preparing','ready','failed'));
      ALTER TABLE workers ADD COLUMN preparation_error TEXT;
      CREATE TABLE workspace_staffing_policies (
        workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
        allowed_command_preset_ids TEXT NOT NULL DEFAULT '[]',
        max_ephemeral_workers INTEGER NOT NULL DEFAULT 2 CHECK(max_ephemeral_workers BETWEEN 1 AND 20)
      );
      CREATE INDEX idx_workers_active_lifecycle ON workers(workspace_id,lifecycle_kind) WHERE retired_at IS NULL;
    `)
  }).immediate()
}
