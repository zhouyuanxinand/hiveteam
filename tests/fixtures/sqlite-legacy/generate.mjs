import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { initializeRuntimeDatabase } from '../../../src/server/sqlite-schema.js'
import { applySchemaVersion47 } from '../../../src/server/sqlite-schema-v47.js'

// One-time fixture producer. Supply the legacy driver's absolute entry path;
// normal tests only read the closed SQLite files and need no legacy dependency.
if (!process.argv[2]) throw new Error('Pass the legacy SQLite driver entry path')
const driverEntry = resolve(process.argv[2])
const { default: LegacyDatabase } = await import(pathToFileURL(driverEntry).href)
const driverPackage = JSON.parse(
  readFileSync(join(dirname(driverEntry), '../package.json'), 'utf8')
)
const destination = dirname(fileURLToPath(import.meta.url))
const parent = resolve(tmpdir())
const temporary = mkdtempSync(join(parent, 'hive-legacy-sqlite-'))
if (dirname(resolve(temporary)) !== parent) throw new Error('Unexpected fixture directory')
const checkpoint = {
  cwd: '/legacy/项目 空格',
  inputSequence: 7,
  lastSubmitAt: 1700000000010,
  offset: 321,
  pasteConfirmed: true,
  runId: 'legacy-run',
  sessionFile: '/legacy/项目 空格/session.jsonl',
  sessionId: 'legacy-session',
  submitAttempts: 2,
}
const provenance = {
  driver: driverPackage.name,
  driver_version: driverPackage.version,
  node_version: process.version,
  source_commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  fixtures: {},
}

const writeFixture = (name, setup, scope) => {
  const path = join(temporary, `${name}.sqlite`)
  const db = new LegacyDatabase(path)
  let sqliteVersion
  try {
    setup(db)
    sqliteVersion = db.prepare('SELECT sqlite_version() AS version').get().version
    const integrity = db.pragma('integrity_check', { simple: true })
    if (integrity !== 'ok') throw new Error(`Invalid fixture: ${integrity}`)
    db.pragma('wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
  const bytes = readFileSync(path)
  writeFileSync(join(destination, `${name}.sqlite.gz`), gzipSync(bytes))
  provenance.fixtures[name] = {
    scope,
    sqlite_version: sqliteVersion,
    uncompressed_bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

const seedOutbox = (db) => {
  db.exec(`
    CREATE TABLE report_outbox (
      id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, target_agent_id TEXT NOT NULL,
      dispatch_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, created_at INTEGER NOT NULL,
      delivered_at INTEGER, delivery_attempts INTEGER NOT NULL DEFAULT 0,
      last_delivery_attempt_at INTEGER, last_delivery_error TEXT
    );
    INSERT INTO report_outbox VALUES
      (1,'legacy-workspace','legacy-workspace:orchestrator','pending-dispatch','待确认汇报',100,NULL,2,120,'retry'),
      (2,'legacy-workspace','legacy-workspace:orchestrator','delivered-dispatch','已送达汇报',101,123,1,122,NULL);
  `)
}

try {
  writeFixture(
    'runtime-v59',
    (db) => {
      initializeRuntimeDatabase(db)
      db.exec(`
      INSERT INTO workspaces(id,name,path,created_at) VALUES('legacy-workspace','旧工作区','/legacy/项目 空格',100);
      INSERT INTO workers(id,workspace_id,name,role,created_at) VALUES('legacy-worker','legacy-workspace','旧成员','coder',101);
      INSERT INTO dispatches(id,workspace_id,from_agent_id,to_agent_id,text,status,created_at,reported_at,report_text,report_outcome,report_revision,accepted_at)
        VALUES('legacy-dispatch','legacy-workspace','legacy-workspace:orchestrator','legacy-worker','执行旧任务','reported',102,103,'旧结果','success',2,104);
      INSERT INTO report_outbox(workspace_id,target_agent_id,dispatch_id,payload,created_at,receipt_id)
        VALUES('legacy-workspace','legacy-workspace:orchestrator','legacy-dispatch','旧汇报',105,'a21bb737-f70a-45de-afbb-1181c68c1c3e');
      INSERT INTO memory_entries(id,workspace_id,scope,fts_rowid,kind,body,status,source,confidence,created_at,updated_at)
        VALUES('legacy-memory','legacy-workspace','workspace',1,'fact','旧驱动保存的记忆','active','manual',1,106,106);
    `)
      db.prepare('UPDATE report_outbox SET delivery_checkpoint = ?').run(JSON.stringify(checkpoint))
    },
    'complete runtime schema 59 with workspace, worker, accepted report, receipt and memory'
  )

  writeFixture(
    'runtime-v4',
    (db) => {
      db.exec(`
      CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      INSERT INTO schema_version VALUES(1,1),(2,2),(3,3),(4,4);
      CREATE TABLE workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,path TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE workers(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,name TEXT NOT NULL,description TEXT,role TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE messages(sequence INTEGER PRIMARY KEY AUTOINCREMENT,workspace_id TEXT NOT NULL,worker_id TEXT NOT NULL,type TEXT NOT NULL,kind TEXT NOT NULL,from_agent_id TEXT,to_agent_id TEXT,text TEXT,status TEXT,artifacts TEXT,created_at INTEGER NOT NULL);
      CREATE TABLE agent_launch_configs(workspace_id TEXT NOT NULL,agent_id TEXT NOT NULL,command TEXT NOT NULL,args_json TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(workspace_id,agent_id));
      CREATE TABLE agent_runs(run_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,status TEXT NOT NULL,exit_code INTEGER,started_at INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      INSERT INTO workspaces VALUES('legacy-workspace','旧工作区','/legacy/项目 空格',100);
      INSERT INTO workers VALUES('legacy-worker','legacy-workspace','旧成员',NULL,'coder',101);
      INSERT INTO messages(workspace_id,worker_id,type,kind,from_agent_id,to_agent_id,text,created_at)
        VALUES('legacy-workspace','legacy-worker','send','send','legacy-workspace:orchestrator','legacy-worker','历史任务 中文',102);
    `)
    },
    'legacy schema 4 from the existing schema-version migration contract'
  )

  writeFixture('report-outbox-v46', seedOutbox, 'report_outbox before version 47 only')
  writeFixture(
    'report-outbox-v47',
    (db) => {
      seedOutbox(db)
      applySchemaVersion47(db)
      db.prepare(
        'UPDATE report_outbox SET receipt_id = ?, delivery_checkpoint = ? WHERE id = 1'
      ).run('a21bb737-f70a-45de-afbb-1181c68c1c3e', JSON.stringify(checkpoint))
      db.prepare('UPDATE report_outbox SET receipt_id = ? WHERE id = 2').run(
        'c3788333-84a1-46b5-a063-cbc9186bece9'
      )
    },
    'report_outbox version 47 with pending checkpoint and historical delivered decision'
  )
  writeFileSync(join(destination, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`)
  console.log(JSON.stringify(provenance, null, 2))
} finally {
  rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
