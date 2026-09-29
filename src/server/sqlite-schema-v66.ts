import type { Database } from './sqlite.js'

export const applySchemaVersion66 = (db: Database) => {
  db.transaction(() => {
    if (
      !(db.pragma('table_info(messages)') as Array<{ name: string }>).some(
        (column) => column.name === 'purpose'
      )
    ) {
      db.exec("ALTER TABLE messages ADD COLUMN purpose TEXT NOT NULL DEFAULT 'legacy'")
      // Older agent messages cannot distinguish business evidence from Dream's own review output.
      db.exec(
        "UPDATE messages SET purpose='conversation' WHERE type IN ('user_input','member_feedback')"
      )
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_dream_window ON messages(workspace_id,purpose,sequence);
      CREATE TABLE IF NOT EXISTS memory_dream_cursors (
        workspace_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL DEFAULT 0,
        offset INTEGER NOT NULL DEFAULT 0, source_hash TEXT, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_dream_deleted_sources (
        workspace_id TEXT NOT NULL, sequence INTEGER NOT NULL, source_hash TEXT NOT NULL,
        deleted_at INTEGER NOT NULL, PRIMARY KEY(workspace_id,sequence)
      );
      CREATE TABLE IF NOT EXISTS memory_dream_generations (
        dream_id TEXT PRIMARY KEY REFERENCES memory_dream_runs(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        input_json TEXT NOT NULL, input_hash TEXT NOT NULL,
        attempt_id TEXT, run_id TEXT, requested_at INTEGER, completed_at INTEGER,
        error TEXT, result_json TEXT, result_hash TEXT, candidate_count INTEGER,
        result_summary TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_dream_generation_pending
        ON memory_dream_generations(workspace_id) WHERE status != 'completed';
      CREATE INDEX IF NOT EXISTS idx_memory_dream_generation_history
        ON memory_dream_generations(workspace_id,created_at);
    `)
  })()
}
