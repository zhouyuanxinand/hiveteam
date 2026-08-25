import type { Database } from 'better-sqlite3'

export const applySchemaVersion22 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS remote_devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_active INTEGER,
      revoked_at INTEGER,
      d2p_key BLOB NOT NULL,
      p2d_key BLOB NOT NULL,
      device_public_key BLOB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_remote_devices_active
      ON remote_devices (revoked_at, created_at);

    CREATE TABLE IF NOT EXISTS remote_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT,
      ts INTEGER NOT NULL,
      workspace_id TEXT,
      action TEXT NOT NULL,
      endpoint TEXT,
      result TEXT NOT NULL,
      reject_reason TEXT,
      byte_count INTEGER,
      preview TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_remote_audit_ts
      ON remote_audit (ts DESC);

    CREATE INDEX IF NOT EXISTS idx_remote_audit_device_ts
      ON remote_audit (device_id, ts DESC);
  `)
}
