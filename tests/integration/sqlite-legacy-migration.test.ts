import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { afterEach, expect, test } from 'vitest'
import { createDispatchLedgerStore } from '../../src/server/dispatch-ledger-store.js'
import { createReportOutboxStore } from '../../src/server/report-outbox-store.js'
import Database from '../../src/server/sqlite.js'
import {
  CURRENT_SCHEMA_VERSION,
  initializeRuntimeDatabase,
} from '../../src/server/sqlite-schema.js'
import { applySchemaVersion47 } from '../../src/server/sqlite-schema-v47.js'
import { createTeamMemoryStore } from '../../src/server/team-memory-store.js'
import { createWorkspaceStore } from '../../src/server/workspace-store.js'

const fixtureDirectory = fileURLToPath(new URL('../fixtures/sqlite-legacy/', import.meta.url))
const provenance = JSON.parse(readFileSync(join(fixtureDirectory, 'provenance.json'), 'utf8'))
const databases: Database[] = []
const directories: string[] = []
const parent = resolve(tmpdir())
const workspaceId = 'legacy-workspace'
const targetAgentId = `${workspaceId}:orchestrator`
const receiptId = 'a21bb737-f70a-45de-afbb-1181c68c1c3e'
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

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close()
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) !== parent)
      throw new Error('Unexpected legacy fixture directory')
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

const open = (path: string) => {
  const db = new Database(path)
  databases.push(db)
  return db
}

const restore = (name: string) => {
  const directory = mkdtempSync(join(parent, 'hive-old-driver-中文 '))
  directories.push(directory)
  const path = join(directory, 'runtime.sqlite')
  const bytes = gunzipSync(readFileSync(join(fixtureDirectory, `${name}.sqlite.gz`)))
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(provenance.fixtures[name].sha256)
  writeFileSync(path, bytes)
  return { path, db: open(path) }
}

test('opens a legacy-driver schema 59 file and preserves business state across new writes and reopen', () => {
  const { path, db } = restore('runtime-v59')
  initializeRuntimeDatabase(db)
  const workspaces = createWorkspaceStore(db, [])
  expect(workspaces.listWorkspaces()).toContainEqual({
    id: workspaceId,
    name: '旧工作区',
    path: '/legacy/项目 空格',
    language: 'zh',
  })
  expect(workspaces.getWorker(workspaceId, 'legacy-worker')).toMatchObject({
    name: '旧成员',
    role: 'coder',
  })
  const dispatches = createDispatchLedgerStore(db)
  expect(dispatches.getDispatchById(workspaceId, 'legacy-dispatch')).toMatchObject({
    status: 'reported',
    reportText: '旧结果',
    reportOutcome: 'success',
    reportRevision: 2,
    acceptedAt: 104,
  })
  const outbox = createReportOutboxStore(db)
  const pending = outbox.listPending(workspaceId, targetAgentId)
  expect(pending).toHaveLength(1)
  expect(pending[0]).toMatchObject({ receiptId, checkpoint, payload: '旧汇报' })
  const memory = createTeamMemoryStore(db)
  expect(memory.get(workspaceId, 'legacy-memory')).toMatchObject({
    body: '旧驱动保存的记忆',
    revision: 1,
  })

  initializeRuntimeDatabase(db)
  workspaces.renameWorker(workspaceId, 'legacy-worker', '新驱动成员')
  memory.update(workspaceId, 'legacy-memory', { body: '新驱动更新后的记忆' })
  const entry = pending[0]
  if (!entry) throw new Error('Missing legacy report')
  outbox.saveCheckpoint(entry.id, entry.receiptId, { ...checkpoint, offset: 654 })
  db.close()

  const reopened = open(path)
  expect(createWorkspaceStore(reopened, []).getWorker(workspaceId, 'legacy-worker').name).toBe(
    '新驱动成员'
  )
  expect(createTeamMemoryStore(reopened).get(workspaceId, 'legacy-memory')).toMatchObject({
    body: '新驱动更新后的记忆',
    revision: 2,
  })
  expect(
    createDispatchLedgerStore(reopened).getDispatchById(workspaceId, 'legacy-dispatch')
  ).toMatchObject({
    reportRevision: 2,
    acceptedAt: 104,
    reportText: '旧结果',
  })
  expect(createReportOutboxStore(reopened).listPending(workspaceId, targetAgentId)).toEqual([
    { ...entry, checkpoint: { ...checkpoint, offset: 654 } },
  ])
  expect(reopened.pragma('foreign_key_check')).toEqual([])
  expect(reopened.pragma('integrity_check', { simple: true })).toBe('ok')
})

test('migrates a legacy-driver schema 4 file through all current migrations', () => {
  const { db, path } = restore('runtime-v4')
  expect(db.prepare('SELECT MAX(version) AS version FROM schema_version').get()).toEqual({
    version: 4,
  })
  initializeRuntimeDatabase(db)
  expect(db.prepare('SELECT MAX(version) AS version FROM schema_version').get()).toEqual({
    version: CURRENT_SCHEMA_VERSION,
  })
  expect(
    db.prepare('SELECT type, text FROM messages WHERE workspace_id = ?').get(workspaceId)
  ).toEqual({
    type: 'send',
    text: '历史任务 中文',
  })
  expect(createWorkspaceStore(db, []).getWorker(workspaceId, 'legacy-worker')).toMatchObject({
    name: '旧成员',
    role: 'coder',
  })
  expect(db.pragma('foreign_key_check')).toEqual([])
  expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
  db.close()
  const reopened = open(path)
  initializeRuntimeDatabase(reopened)
  expect(reopened.prepare('SELECT COUNT(*) AS count FROM schema_version').get()).toEqual({
    count: CURRENT_SCHEMA_VERSION,
  })
  expect(
    reopened.prepare('SELECT type, text FROM messages WHERE workspace_id = ?').get(workspaceId)
  ).toEqual({
    type: 'send',
    text: '历史任务 中文',
  })
})

test('adds stable receipt IDs to a legacy-driver pre-47 outbox without redelivering historical reports', () => {
  const { db, path } = restore('report-outbox-v46')
  applySchemaVersion47(db)
  const pending = db
    .prepare('SELECT * FROM report_outbox WHERE delivered_at IS NULL ORDER BY id')
    .all()
  expect(pending).toHaveLength(1)
  expect(pending[0]).toMatchObject({
    dispatch_id: 'pending-dispatch',
    payload: '待确认汇报',
    delivered_at: null,
    delivery_checkpoint: null,
    receipt_id: expect.stringMatching(/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/),
  })
  expect(db.prepare('SELECT delivered_at FROM report_outbox WHERE id = 2').get()).toEqual({
    delivered_at: 123,
  })
  db.close()
  const reopened = open(path)
  applySchemaVersion47(reopened)
  expect(
    reopened.prepare('SELECT * FROM report_outbox WHERE delivered_at IS NULL ORDER BY id').all()
  ).toEqual(pending)
  expect(reopened.prepare('SELECT delivered_at FROM report_outbox WHERE id = 2').get()).toEqual({
    delivered_at: 123,
  })
})

test('retains a legacy-driver v47 receipt checkpoint and commits delivery without resurrecting it', () => {
  const { db, path } = restore('report-outbox-v47')
  applySchemaVersion47(db)
  const pending = db
    .prepare('SELECT * FROM report_outbox WHERE delivered_at IS NULL ORDER BY id')
    .all()
  expect(pending).toHaveLength(1)
  expect(pending[0]).toMatchObject({
    receipt_id: receiptId,
    delivery_checkpoint: JSON.stringify(checkpoint),
    delivered_at: null,
    delivery_attempts: 2,
  })
  db.transaction(() =>
    db.prepare('UPDATE report_outbox SET delivered_at = ? WHERE id = 1').run(1700000000020)
  )()
  db.close()
  const reopened = open(path)
  applySchemaVersion47(reopened)
  expect(reopened.prepare('SELECT * FROM report_outbox WHERE delivered_at IS NULL').all()).toEqual(
    []
  )
  expect(
    reopened.prepare('SELECT receipt_id, delivery_checkpoint FROM report_outbox WHERE id = 1').get()
  ).toEqual({
    receipt_id: receiptId,
    delivery_checkpoint: JSON.stringify(checkpoint),
  })
  expect(reopened.pragma('integrity_check', { simple: true })).toBe('ok')
})
