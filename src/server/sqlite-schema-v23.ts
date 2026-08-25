import type { Database } from 'better-sqlite3'

export const applySchemaVersion23 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      scope TEXT NOT NULL DEFAULT 'workspace',
      fts_rowid INTEGER UNIQUE,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      tags TEXT,
      status TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      confidence REAL,
      pinned INTEGER NOT NULL DEFAULT 0,
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER,
      last_injected_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_memory_entries_ws_status
      ON memory_entries (workspace_id, status);

    CREATE INDEX IF NOT EXISTS idx_memory_entries_ws_updated
      ON memory_entries (workspace_id, updated_at);

    CREATE TABLE IF NOT EXISTS memory_sources (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL,
      source_id TEXT,
      source_sequence INTEGER,
      excerpt TEXT,
      text_hash TEXT,
      actor_agent_id_snapshot TEXT,
      actor_name_snapshot TEXT,
      actor_role_snapshot TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_sources_memory
      ON memory_sources (memory_id);

    CREATE TABLE IF NOT EXISTS memory_injections (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
      workspace_id TEXT,
      target_agent_id_snapshot TEXT,
      context_type TEXT NOT NULL,
      dispatch_id TEXT,
      injected_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_injections_ws
      ON memory_injections (workspace_id, injected_at);

    CREATE INDEX IF NOT EXISTS idx_memory_injections_memory
      ON memory_injections (memory_id, injected_at);
  `)
}
