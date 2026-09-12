import type { Database } from 'better-sqlite3'

/** Persists immutable evidence from read-only effective-Skill scans. */
export const applySchemaVersion34 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_snapshots (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      command_preset_id TEXT,
      snapshot_json TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_skill_snapshots_workspace_agent_created
      ON skill_snapshots (workspace_id, agent_id, sequence DESC);
  `)
}
