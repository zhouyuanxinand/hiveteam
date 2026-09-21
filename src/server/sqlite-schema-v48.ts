import type { Database } from 'better-sqlite3'

export const applySchemaVersion48 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_unsafe_grants (
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      cli_fingerprint TEXT NOT NULL,
      cli_version TEXT,
      policy_revision INTEGER NOT NULL,
      granted_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, agent_id)
    );
    CREATE TABLE IF NOT EXISTS execution_policy_snapshots (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      run_id TEXT
    );
    CREATE INDEX IF NOT EXISTS execution_policy_snapshots_agent
      ON execution_policy_snapshots (workspace_id, agent_id, created_at);
    CREATE TABLE IF NOT EXISTS execution_policy_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      details_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `)
}
