import type { Database } from 'better-sqlite3'
import { BUILTIN_COMMAND_PRESETS } from './command-preset-defaults.js'

export const applySchemaVersion57 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS native_session_generations (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL, generation INTEGER NOT NULL, harness TEXT NOT NULL,
      native_id TEXT, storage_root TEXT NOT NULL, context_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','bound','uncertain')),
      current INTEGER NOT NULL CHECK(current IN (0,1)), reason TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      error_code TEXT, error_message TEXT,
      UNIQUE(workspace_id,agent_id,generation)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS native_session_current
      ON native_session_generations(workspace_id,agent_id) WHERE current = 1;
    CREATE UNIQUE INDEX IF NOT EXISTS native_session_identity
      ON native_session_generations(harness,storage_root,native_id) WHERE native_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS native_session_attempts (
      id TEXT PRIMARY KEY, generation_id TEXT NOT NULL REFERENCES native_session_generations(id) ON DELETE CASCADE,
      operation TEXT NOT NULL CHECK(operation IN ('allocate','resume')),
      state TEXT NOT NULL CHECK(state IN ('prepared','allocating','starting','active','closed','failed','uncertain')),
      reservation_id TEXT NOT NULL, run_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      error_code TEXT, error_message TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS native_session_writer
      ON native_session_attempts(generation_id) WHERE state IN ('prepared','allocating','starting','active');
    CREATE TABLE IF NOT EXISTS native_session_context_events (
      id TEXT PRIMARY KEY, generation_id TEXT NOT NULL REFERENCES native_session_generations(id) ON DELETE CASCADE,
      before_json TEXT NOT NULL, after_json TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL
    );
  `)
  if (db.prepare('SELECT 1 FROM schema_version WHERE version=57').get()) return
  const insert =
    db.prepare(`INSERT INTO command_presets(id,display_name,command,args,env,resume_args_template,session_id_capture,yolo_args_template,is_builtin,created_at,updated_at)
    VALUES(?,?,?,'[]','{}',NULL,NULL,'[]',1,?,?) ON CONFLICT(id) DO NOTHING`)
  for (const preset of BUILTIN_COMMAND_PRESETS.filter(
    (item) => item.id === 'cursor' || item.id === 'grok'
  ))
    insert.run(preset.id, preset.displayName, preset.command, Date.now(), Date.now())
}
