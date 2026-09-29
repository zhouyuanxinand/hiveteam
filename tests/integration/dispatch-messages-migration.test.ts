import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, expect, test } from 'vitest'
import { createDispatchLedgerStore } from '../../src/server/dispatch-ledger-store.js'
import { createDispatchMessageStore } from '../../src/server/dispatch-message-store.js'
import { createReportOutboxStore } from '../../src/server/report-outbox-store.js'
import Database from '../../src/server/sqlite.js'
import {
  CURRENT_SCHEMA_VERSION,
  initializeRuntimeDatabase,
} from '../../src/server/sqlite-schema.js'
import { applySchemaVersion60 } from '../../src/server/sqlite-schema-v60.js'

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})
const setup = () => {
  const directory = mkdtempSync(join(tmpdir(), 'hive-message-migration-'))
  const path = join(directory, 'runtime.sqlite')
  writeFileSync(
    path,
    gunzipSync(
      readFileSync(new URL('../fixtures/sqlite-legacy/runtime-v59.sqlite.gz', import.meta.url))
    )
  )
  const db = new Database(path)
  cleanup.push(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return db
}

test('schema 59 upgrades without changing receipt IDs, checkpoints, row ordering, audit history, or legacy dispatches', () => {
  const db = setup()
  db.pragma('foreign_keys=ON')
  const snapshots = ['message_deliveries', 'message_delivery_events', 'report_outbox'].map(
    (table) => ({ table, rows: db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all() })
  )
  initializeRuntimeDatabase(db)
  for (const { table, rows } of snapshots)
    expect(db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()).toEqual(rows)
  expect(db.pragma('foreign_key_check')).toEqual([])
  expect(db.prepare('SELECT DISTINCT message_protocol_version FROM dispatches').all()).toEqual([
    { message_protocol_version: 0 },
  ])
  const ledger = createDispatchLedgerStore(db)
  const dispatch = ledger.createDispatch({
    workspaceId: 'legacy-workspace',
    toAgentId: 'legacy-worker',
    text: 'New protocol',
    messageProtocolVersion: 1,
  })
  const messages = createDispatchMessageStore(db)
  const message = messages.create(
    'legacy-workspace',
    dispatch.id,
    'legacy-workspace:orchestrator',
    { kind: 'note', body: 'New requirement' }
  )
  const outbox = createReportOutboxStore(db)
  outbox.enqueue({
    workspaceId: 'legacy-workspace',
    dispatchId: dispatch.id,
    targetAgentId: 'legacy-workspace:orchestrator',
    payload: 'Report',
  })
  expect(
    db
      .prepare('SELECT kind FROM message_deliveries WHERE dispatch_id=? ORDER BY rowid')
      .all(dispatch.id)
  ).toEqual([{ kind: 'dispatch' }, { kind: 'message' }, { kind: 'report' }])
  initializeRuntimeDatabase(db)
  expect(messages.list('legacy-workspace', dispatch.id, 'legacy-worker').messages[0]?.id).toBe(
    message.id
  )
  expect(db.prepare('SELECT MAX(version) AS version FROM schema_version').get()).toEqual({
    version: CURRENT_SCHEMA_VERSION,
  })
  ledger.deleteDispatch(dispatch.id)
  expect(
    db.prepare('SELECT * FROM dispatch_messages WHERE dispatch_id=?').all(dispatch.id)
  ).toEqual([])
  expect(db.pragma('foreign_key_check')).toEqual([])
})

test('an upgrade error rolls back both copied receipt history and the protocol column', () => {
  const db = setup()
  const before = db.prepare('SELECT rowid,* FROM message_deliveries ORDER BY rowid').all()
  db.exec('CREATE TABLE message_delivery_events_v60 (collision TEXT)')
  expect(() => applySchemaVersion60(db)).toThrow('already exists')
  expect(db.pragma('table_info(dispatches)')).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'message_protocol_version' })])
  )
  expect(db.prepare('SELECT rowid,* FROM message_deliveries ORDER BY rowid').all()).toEqual(before)
  db.exec('DROP TABLE message_delivery_events_v60')
  initializeRuntimeDatabase(db)
  expect(db.prepare('SELECT rowid,* FROM message_deliveries ORDER BY rowid').all()).toEqual(before)
})
