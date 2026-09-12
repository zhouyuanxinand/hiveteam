import type { Database } from 'better-sqlite3'

/** Stores immutable, content-addressed Skill Pack releases. */
export const applySchemaVersion35 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_pack_releases (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_uri TEXT NOT NULL,
      source_json TEXT NOT NULL,
      resolved_revision TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      source_dirty INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE (source_type, source_uri, source_json, resolved_revision, content_digest)
    );

    CREATE INDEX IF NOT EXISTS idx_skill_pack_releases_digest
      ON skill_pack_releases (content_digest);
  `)
}
