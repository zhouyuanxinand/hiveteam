import type { Database } from 'better-sqlite3'

import { applySchemaVersion5 } from './sqlite-schema-v5.js'
import { applySchemaVersion7 } from './sqlite-schema-v7.js'
import { applySchemaVersion8 } from './sqlite-schema-v8.js'
import { applySchemaVersion9 } from './sqlite-schema-v9.js'
import { applySchemaVersion10 } from './sqlite-schema-v10.js'
import { applySchemaVersion11 } from './sqlite-schema-v11.js'
import { applySchemaVersion12 } from './sqlite-schema-v12.js'
import { applySchemaVersion13 } from './sqlite-schema-v13.js'
import { applySchemaVersion14 } from './sqlite-schema-v14.js'
import { applySchemaVersion15 } from './sqlite-schema-v15.js'
import { applySchemaVersion16 } from './sqlite-schema-v16.js'
import { applySchemaVersion17 } from './sqlite-schema-v17.js'
import { applySchemaVersion18 } from './sqlite-schema-v18.js'
import { applySchemaVersion19 } from './sqlite-schema-v19.js'
import { applySchemaVersion20 } from './sqlite-schema-v20.js'
import { applySchemaVersion21 } from './sqlite-schema-v21.js'
import { applySchemaVersion22 } from './sqlite-schema-v22.js'
import { applySchemaVersion23 } from './sqlite-schema-v23.js'
import { applySchemaVersion24 } from './sqlite-schema-v24.js'
import { applySchemaVersion25 } from './sqlite-schema-v25.js'
import { applySchemaVersion26 } from './sqlite-schema-v26.js'
import { applySchemaVersion27 } from './sqlite-schema-v27.js'
import { applySchemaVersion28 } from './sqlite-schema-v28.js'
import { applySchemaVersion29 } from './sqlite-schema-v29.js'
import { applySchemaVersion30 } from './sqlite-schema-v30.js'
import { applySchemaVersion31 } from './sqlite-schema-v31.js'
import { applySchemaVersion32 } from './sqlite-schema-v32.js'
import { applySchemaVersion33 } from './sqlite-schema-v33.js'

export const CURRENT_SCHEMA_VERSION = 33

export const initializeRuntimeDatabase = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'zh',
      auto_resume INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      avatar TEXT,
      description TEXT,
      last_session_id TEXT,
      manual_stop INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      type TEXT NOT NULL,
      from_agent_id TEXT,
      to_agent_id TEXT,
      text TEXT,
      status TEXT,
      artifacts TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_launch_configs (
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      command TEXT NOT NULL,
      args_json TEXT NOT NULL,
      command_preset_id TEXT,
      interactive_command TEXT,
      preset_augmentation_disabled INTEGER NOT NULL DEFAULT 0,
      resume_args_template TEXT,
      session_id_capture_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      run_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      pid INTEGER,
      status TEXT NOT NULL,
      exit_code INTEGER,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      consecutive_fast_exits INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_sessions (
      agent_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      last_session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS dispatches (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      from_agent_id TEXT,
      to_agent_id TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER,
      submitted_at INTEGER,
      reported_at INTEGER,
      report_text TEXT,
      artifacts TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_dispatches_workspace_created_at
      ON dispatches (workspace_id, sequence);

    CREATE INDEX IF NOT EXISTS idx_dispatches_open_by_worker
      ON dispatches (workspace_id, to_agent_id, status, sequence);

    -- This table also exists in the published 2.1.19 runtime. Keep it in the
    -- unconditional bootstrap block so databases that already recorded newer
    -- schema versions (v22+) still receive it when opened by this branch.
    CREATE TABLE IF NOT EXISTS report_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      target_agent_id TEXT NOT NULL,
      dispatch_id TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER,
      delivery_attempts INTEGER NOT NULL DEFAULT 0,
      last_delivery_attempt_at INTEGER,
      last_delivery_error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_report_outbox_pending
      ON report_outbox (workspace_id, target_agent_id, delivered_at, created_at);

    -- Keep delivery failures separate from the stable dispatch ledger schema.
    -- The original queued/submitted row remains available for replay.
    CREATE TABLE IF NOT EXISTS dispatch_delivery_failures (
      dispatch_id TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL,
      last_attempt_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_dispatch_delivery_failures_attempted
      ON dispatch_delivery_failures (last_attempt_at);
  `)

  const workspaceColumns = new Set(
    (db.prepare('PRAGMA table_info(workspaces)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (!workspaceColumns.has('auto_resume')) {
    db.exec('ALTER TABLE workspaces ADD COLUMN auto_resume INTEGER NOT NULL DEFAULT 1')
  }

  const agentRunColumns = new Set(
    (db.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (!agentRunColumns.has('consecutive_fast_exits')) {
    db.exec('ALTER TABLE agent_runs ADD COLUMN consecutive_fast_exits INTEGER NOT NULL DEFAULT 0')
  }

  const versions = db
    .prepare('SELECT version FROM schema_version ORDER BY version ASC')
    .all() as Array<{ version: number }>
  const appliedVersions = new Set(versions.map((row) => row.version))

  if (!appliedVersions.has(1)) {
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, Date.now())
    appliedVersions.add(1)
  }

  if (!appliedVersions.has(2)) {
    const workerColumns = new Set(
      (db.prepare('PRAGMA table_info(workers)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )

    if (workerColumns.size > 0 && !workerColumns.has('description')) {
      db.exec('ALTER TABLE workers ADD COLUMN description TEXT')
    }

    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(2, Date.now())
  }

  if (!appliedVersions.has(3)) {
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(3, Date.now())
    appliedVersions.add(3)
  }

  if (!appliedVersions.has(4)) {
    const messageColumns = new Set(
      (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )

    if (messageColumns.size > 0 && !messageColumns.has('artifacts')) {
      db.exec('ALTER TABLE messages ADD COLUMN artifacts TEXT')
    }

    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(4, Date.now())
  }

  if (!appliedVersions.has(5)) {
    applySchemaVersion5(db)

    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(5, Date.now())
  }

  if (!appliedVersions.has(6)) {
    const launchConfigColumns = new Set(
      (db.prepare('PRAGMA table_info(agent_launch_configs)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    if (!launchConfigColumns.has('resume_args_template')) {
      db.exec('ALTER TABLE agent_launch_configs ADD COLUMN resume_args_template TEXT')
    }
    if (!launchConfigColumns.has('session_id_capture_json')) {
      db.exec('ALTER TABLE agent_launch_configs ADD COLUMN session_id_capture_json TEXT')
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        agent_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        last_session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, agent_id)
      );
    `)

    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(6, Date.now())
  }

  if (!appliedVersions.has(7)) {
    applySchemaVersion7(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(7, Date.now())
  }

  if (!appliedVersions.has(8)) {
    applySchemaVersion8(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(8, Date.now())
  }

  if (!appliedVersions.has(9)) {
    applySchemaVersion9(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(9, Date.now())
  }

  if (!appliedVersions.has(10)) {
    applySchemaVersion10(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(10, Date.now())
  }

  if (!appliedVersions.has(11)) {
    applySchemaVersion11(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(11, Date.now())
  }

  if (!appliedVersions.has(12)) {
    applySchemaVersion12(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(12, Date.now())
  }

  if (!appliedVersions.has(13)) {
    applySchemaVersion13(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(13, Date.now())
  }

  if (!appliedVersions.has(14)) {
    applySchemaVersion14(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(14, Date.now())
  }

  if (!appliedVersions.has(15)) {
    applySchemaVersion15(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(15, Date.now())
  }

  if (!appliedVersions.has(16)) {
    applySchemaVersion16(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(16, Date.now())
  }

  if (!appliedVersions.has(17)) {
    applySchemaVersion17(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(17, Date.now())
  }

  if (!appliedVersions.has(18)) {
    applySchemaVersion18(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(18, Date.now())
  }

  if (!appliedVersions.has(19)) {
    applySchemaVersion19(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(19, Date.now())
  }

  if (!appliedVersions.has(20)) {
    applySchemaVersion20(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(20, Date.now())
  } else {
    // Some packaged builds may have used this version number before all
    // built-in presets shipped. Keep the backfill idempotent on every start
    // so those databases still receive newly added presets.
    applySchemaVersion20(db)
  }

  if (!appliedVersions.has(21)) {
    applySchemaVersion21(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(21, Date.now())
  }

  if (!appliedVersions.has(22)) {
    applySchemaVersion22(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(22, Date.now())
  }

  if (!appliedVersions.has(23)) {
    applySchemaVersion23(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(23, Date.now())
  } else {
    // Published Hive builds used v23 before Team Memory arrived in v26.
    // Keep this idempotent bootstrap so a database moving to HiveTeam still
    // receives the compatible memory tables without depending on official
    // later-version migrations.
    applySchemaVersion23(db)
  }

  if (!appliedVersions.has(24)) {
    applySchemaVersion24(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(24, Date.now())
  } else {
    applySchemaVersion24(db)
  }

  if (!appliedVersions.has(25)) {
    applySchemaVersion25(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(25, Date.now())
  } else {
    applySchemaVersion25(db)
  }

  if (!appliedVersions.has(26)) {
    applySchemaVersion26(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(26, Date.now())
  } else {
    applySchemaVersion26(db)
  }

  if (!appliedVersions.has(27)) {
    applySchemaVersion27(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(27, Date.now())
  } else {
    applySchemaVersion27(db)
  }

  if (!appliedVersions.has(28)) {
    applySchemaVersion28(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(28, Date.now())
  } else {
    applySchemaVersion28(db)
  }

  if (!appliedVersions.has(29)) {
    applySchemaVersion29(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(29, Date.now())
  }

  if (!appliedVersions.has(30)) {
    applySchemaVersion30(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(30, Date.now())
  } else {
    applySchemaVersion30(db)
  }

  if (!appliedVersions.has(31)) {
    applySchemaVersion31(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(31, Date.now())
  } else {
    applySchemaVersion31(db)
  }

  if (!appliedVersions.has(32)) {
    applySchemaVersion32(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(32, Date.now())
  } else {
    applySchemaVersion32(db)
  }

  if (!appliedVersions.has(33)) {
    applySchemaVersion33(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(33, Date.now())
  } else {
    applySchemaVersion33(db)
  }
}
