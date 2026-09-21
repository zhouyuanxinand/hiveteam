export interface HiveBackupManifest {
  format: 'hive-local-backup'
  format_version: 1
  id: string
  created_at: number
  app_version: string
  schema_version: number
  platform: string
  architecture: string
  database: { path: 'runtime.sqlite'; sha256: string; bytes: number }
  records: Record<string, number>
  attachments: Array<{ path: string; sha256: string; bytes: number; target: string | null }>
  workspaces: Array<{ id: string; name: string; path: string; included: false }>
  native_sessions: Array<{
    generation_id: string
    harness: string
    native_id: string | null
    storage_root: string
    included: boolean
  }>
  external_references: Array<{ kind: string; reference: string; included: false }>
  credentials: 'excluded_requires_new_authentication_and_pairing'
  cleanup: 'raw_snapshot_removed'
  sensitivity: 'Natural-language content and optional sessions may contain secrets. Treat this directory as sensitive.'
}
