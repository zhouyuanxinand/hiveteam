import type { Database } from 'better-sqlite3'

/** Called only by schema migration 50. */
export const applyResourceQueueSchema = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resource_start_queue (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agent_id TEXT,
      execution_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      source TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      remote_guard_json TEXT,
      status TEXT NOT NULL CHECK(status IN ('queued','starting','started','failed','cancelled')),
      reason TEXT,
      reservation_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      run_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS resource_start_queue_active_key
      ON resource_start_queue(workspace_id,execution_key) WHERE status IN ('queued','starting');
    CREATE INDEX IF NOT EXISTS resource_start_queue_workspace_order
      ON resource_start_queue(workspace_id,status,sequence);
    CREATE TABLE IF NOT EXISTS resource_queue_cursor (
      id INTEGER PRIMARY KEY CHECK(id=1),
      last_workspace_id TEXT
    );
    INSERT OR IGNORE INTO resource_queue_cursor(id,last_workspace_id) VALUES(1,NULL);
    CREATE TABLE IF NOT EXISTS resource_agent_pauses (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      PRIMARY KEY(workspace_id,agent_id)
    );
    CREATE TABLE IF NOT EXISTS resource_dispatch_guards (
      dispatch_id TEXT PRIMARY KEY REFERENCES dispatches(id) ON DELETE CASCADE,
      remote_guard_json TEXT NOT NULL
    );
  `)
}
