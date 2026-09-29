import type { Database } from './sqlite.js'

export const applySchemaVersion55 = (db: Database) => {
  db.exec(`CREATE TABLE IF NOT EXISTS verification_profiles (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, id TEXT NOT NULL, profile_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL, PRIMARY KEY(workspace_id,id)
  )`)
  const columns = new Set(
    (db.prepare('PRAGMA table_info(dispatch_verifications)').all() as Array<{ name: string }>).map(
      (row) => row.name
    )
  )
  for (const [name, type] of [
    ['profile_json', 'TEXT'],
    ['log_bytes', 'INTEGER NOT NULL DEFAULT 0'],
    ['subject_json', 'TEXT'],
  ] as const)
    if (!columns.has(name)) db.exec(`ALTER TABLE dispatch_verifications ADD COLUMN ${name} ${type}`)
}
