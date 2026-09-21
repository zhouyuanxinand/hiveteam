import type { Database } from 'better-sqlite3'
export const applySchemaVersion56 = (db: Database) => {
  db.exec(`CREATE TABLE IF NOT EXISTS integration_candidates (
    id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,dispatch_id TEXT NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
    snapshot TEXT NOT NULL,created_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS idx_integration_candidate_dispatch ON integration_candidates(workspace_id,dispatch_id,created_at);
  CREATE TABLE IF NOT EXISTS integration_candidate_events (
    id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES integration_candidates(id) ON DELETE CASCADE,
    recorded_at INTEGER NOT NULL, snapshot TEXT NOT NULL
  );`)
}
