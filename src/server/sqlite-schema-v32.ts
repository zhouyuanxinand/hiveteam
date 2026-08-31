import type { Database } from 'better-sqlite3'

/** Stores durable Supervisor-to-Orchestrator goal sessions and their event stream. */
export const applySchemaVersion32 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_goal_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      goal TEXT NOT NULL,
      context_json TEXT NOT NULL,
      title TEXT,
      summary TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      closed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_external_goal_sessions_workspace
      ON external_goal_sessions (workspace_id, created_at);

    CREATE TABLE IF NOT EXISTS external_goal_events (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      status TEXT,
      body TEXT NOT NULL,
      artifacts_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(goal_id, sequence)
    );

    CREATE INDEX IF NOT EXISTS idx_external_goal_events_goal
      ON external_goal_events (goal_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_external_goal_events_workspace
      ON external_goal_events (workspace_id, created_at);
  `)
}
