import type { Database } from 'better-sqlite3'

export const applySchemaVersion49 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS remote_read_scopes (
      device_id TEXT NOT NULL REFERENCES remote_devices(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      PRIMARY KEY (device_id, workspace_id)
    );
    CREATE TABLE IF NOT EXISTS remote_access_requests (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES remote_devices(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      actions_json TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      requested_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      runtime_instance_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'expired')),
      resolved_at INTEGER,
      grant_id TEXT
    );
    CREATE TABLE IF NOT EXISTS remote_write_grants (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE REFERENCES remote_access_requests(id),
      device_id TEXT NOT NULL REFERENCES remote_devices(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      actions_json TEXT NOT NULL,
      approved_by TEXT NOT NULL,
      runtime_instance_id TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      expiry_audited INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS remote_grants_device ON remote_write_grants(device_id, workspace_id);
  `)
  const columns = new Set(
    (db.prepare('PRAGMA table_info(remote_audit)').all() as Array<{ name: string }>).map(
      (c) => c.name
    )
  )
  for (const [name, type] of [
    ['method', 'TEXT'],
    ['business_action', 'TEXT'],
    ['resource_id', 'TEXT'],
    ['grant_id', 'TEXT'],
    ['decision', 'TEXT'],
    ['status_code', 'INTEGER'],
  ] as const) {
    if (!columns.has(name)) db.exec(`ALTER TABLE remote_audit ADD COLUMN ${name} ${type}`)
  }
  // Historical keystroke previews are not needed to understand execution outcomes.
  db.prepare('UPDATE remote_audit SET preview = NULL WHERE preview IS NOT NULL').run()
}
