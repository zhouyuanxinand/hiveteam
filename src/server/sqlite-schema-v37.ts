import type { Database } from 'better-sqlite3'

export const applySchemaVersion37 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatch_skill_activations (
      dispatch_id TEXT PRIMARY KEY,
      release_id TEXT NOT NULL,
      pack_name TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      skill_digest TEXT NOT NULL,
      instruction_snapshot TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      delivery_mode TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_dispatch_skill_activations_release
      ON dispatch_skill_activations (release_id, created_at);
  `)
}
