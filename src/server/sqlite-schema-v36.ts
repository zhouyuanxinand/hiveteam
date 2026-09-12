import type { Database } from 'better-sqlite3'

export const applySchemaVersion36 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_change_plans (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      action TEXT NOT NULL,
      intent_json TEXT NOT NULL,
      operations_json TEXT NOT NULL,
      internal_state_json TEXT NOT NULL,
      before_fingerprint TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      applied_attempt_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_skill_change_plans_workspace_created
      ON skill_change_plans (workspace_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS skill_change_attempts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      state TEXT NOT NULL,
      journal_json TEXT NOT NULL,
      error TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_skill_change_attempts_workspace_started
      ON skill_change_attempts (workspace_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS skill_placements (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      release_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      canonical_target_path TEXT NOT NULL,
      expected_link_target TEXT NOT NULL,
      before_fingerprint TEXT NOT NULL,
      after_fingerprint TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      removed_at INTEGER
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_placements_active_target
      ON skill_placements (workspace_id, canonical_target_path)
      WHERE state = 'active';

    CREATE INDEX IF NOT EXISTS idx_skill_placements_workspace_state
      ON skill_placements (workspace_id, state, created_at);
  `)
}
