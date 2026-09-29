import type { Database } from './sqlite.js'

/** Rebuild the verification CHECK without deleting integration or pull-request evidence. */
export const applySchemaVersion51 = (db: Database) => {
  const table = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dispatch_verifications'"
    )
    .get() as { sql: string }
  if (table.sql.includes("'queued'")) return
  if (db.inTransaction)
    throw new Error('Verification state migration must run outside a transaction.')
  const foreignKeys = db.pragma('foreign_keys', { simple: true })
  db.pragma('foreign_keys = OFF')
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE dispatch_verifications_v51 (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          dispatch_id TEXT NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
          report_revision INTEGER NOT NULL,
          head_sha TEXT NOT NULL,
          command TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'passed', 'failed', 'cancelled', 'interrupted')),
          output TEXT NOT NULL DEFAULT '',
          output_truncated INTEGER NOT NULL DEFAULT 0,
          exit_code INTEGER,
          error TEXT,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          accepted_at INTEGER
        );
        INSERT INTO dispatch_verifications_v51 SELECT * FROM dispatch_verifications;
        DROP TABLE dispatch_verifications;
        ALTER TABLE dispatch_verifications_v51 RENAME TO dispatch_verifications;
        CREATE INDEX idx_dispatch_verifications_dispatch
          ON dispatch_verifications(workspace_id, dispatch_id, started_at DESC);
      `)
      const violations = db.pragma('foreign_key_check') as unknown[]
      if (violations.length)
        throw new Error('Verification migration would leave invalid foreign-key references.')
    })()
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`)
  }
}
