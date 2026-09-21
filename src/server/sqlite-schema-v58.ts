import type { Database } from 'better-sqlite3'

export const applySchemaVersion58 = (db: Database) => {
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_creation_attempts (
    id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
    mode TEXT NOT NULL CHECK(mode IN ('basic','packs')),
    state TEXT NOT NULL CHECK(state IN ('pending','succeeded','failed')),
    started_at INTEGER NOT NULL, completed_at INTEGER, failure_code TEXT,
    first_dispatch_at INTEGER, first_report_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS workspace_creation_workspace ON workspace_creation_attempts(workspace_id);
  CREATE TRIGGER IF NOT EXISTS workspace_first_dispatch AFTER INSERT ON dispatches BEGIN
    UPDATE workspace_creation_attempts SET first_dispatch_at=COALESCE(first_dispatch_at,NEW.created_at)
      WHERE workspace_id=NEW.workspace_id AND state='succeeded';
  END;
  CREATE TRIGGER IF NOT EXISTS workspace_first_report AFTER UPDATE OF status ON dispatches
    WHEN NEW.status='reported' BEGIN
    UPDATE workspace_creation_attempts SET first_report_at=COALESCE(first_report_at,NEW.reported_at)
      WHERE workspace_id=NEW.workspace_id AND state='succeeded';
  END;`)
}
