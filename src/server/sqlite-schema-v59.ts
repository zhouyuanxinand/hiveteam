import type { Database } from 'better-sqlite3'

export const applySchemaVersion59 = (db: Database) => {
  if (
    !(db.pragma('table_info(memory_entries)') as Array<{ name: string }>).some(
      (column) => column.name === 'revision'
    )
  )
    db.exec('ALTER TABLE memory_entries ADD COLUMN revision INTEGER NOT NULL DEFAULT 1')
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_revisions (
      memory_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(memory_id, revision)
    );
    INSERT OR IGNORE INTO memory_revisions SELECT id,revision,body,json_object('kind',kind,'tags',tags,'status',status,'ref_type',ref_type,'ref_id',ref_id,'ref_title',ref_title),updated_at FROM memory_entries;
    CREATE TRIGGER IF NOT EXISTS memory_revision_insert AFTER INSERT ON memory_entries BEGIN
      INSERT INTO memory_revisions VALUES(NEW.id,NEW.revision,NEW.body,json_object('kind',NEW.kind,'tags',NEW.tags,'status',NEW.status,'ref_type',NEW.ref_type,'ref_id',NEW.ref_id,'ref_title',NEW.ref_title),NEW.updated_at);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_revision_update AFTER UPDATE OF body,tags,kind,status,disabled,pinned,scope,ref_type,ref_id,ref_title ON memory_entries BEGIN
      UPDATE memory_entries SET revision=OLD.revision+1 WHERE id=NEW.id;
      INSERT INTO memory_revisions VALUES(NEW.id,OLD.revision+1,NEW.body,json_object('kind',NEW.kind,'tags',NEW.tags,'status',NEW.status,'ref_type',NEW.ref_type,'ref_id',NEW.ref_id,'ref_title',NEW.ref_title),NEW.updated_at);
    END;
    CREATE TABLE IF NOT EXISTS memory_context_snapshots (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL, context TEXT NOT NULL,
      dispatch_id TEXT, run_id TEXT, query TEXT NOT NULL, budget INTEGER NOT NULL, used_chars INTEGER NOT NULL,
      digest TEXT NOT NULL, candidates_json TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memory_context_workspace ON memory_context_snapshots(workspace_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS data_archive_operations (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, preview_version TEXT NOT NULL, receipt_json TEXT NOT NULL, completed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dispatch_archives (
      dispatch_id TEXT PRIMARY KEY REFERENCES dispatches(id), operation_id TEXT NOT NULL REFERENCES data_archive_operations(id), archived_at INTEGER NOT NULL
    );
  `)
}
