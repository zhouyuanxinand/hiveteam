import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createDispatchLedgerStore } from '../../src/server/dispatch-ledger-store.js'
import { createMessageDeliveryStore } from '../../src/server/message-delivery-store.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

test.each([
  'attempting',
  'unknown',
  'manual',
  'pending',
] as const)('a recipient blocked by %s cannot fill the due batch and starve independent recipients', (state) => {
  const directory = mkdtempSync(join(tmpdir(), 'hive-delivery-scheduling-'))
  const db = new Database(join(directory, 'runtime.sqlite'))
  cleanups.push(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  initializeRuntimeDatabase(db)
  const ledger = createDispatchLedgerStore(db)
  const workspaceId = randomUUID(),
    recipientId = randomUUID()
  const create = (workspace = workspaceId, recipient = recipientId) =>
    ledger.createDispatch({ workspaceId: workspace, toAgentId: recipient, text: 'Queued task' })
  const first = create()
  const now = Date.now() + 1000
  const records = createMessageDeliveryStore(db, () => now)
  expect(records.claim(first.id, 'original-run')?.attempt).toBe(1)
  if (state === 'unknown') {
    records.beforeWrite(first.id, 1)
    records.failed(first.id, 1, 'Receipt not yet known')
    records.defer(first.id, 'Waiting for a receipt')
  } else if (state !== 'attempting') {
    records.failed(first.id, 1, 'Composer is not ready', state === 'manual' ? 'manual' : false)
  }
  expect(records.get(first.id)?.state).toBe(state)
  const backlog = db.transaction(() => Array.from({ length: 205 }, () => create()))()
  const sameWorkspace = create(workspaceId, randomUUID())
  const otherWorkspace = create(randomUUID(), randomUUID())

  expect(records.due().map((record) => record.id)).toEqual([sameWorkspace.id, otherWorkspace.id])
  expect(records.claim(backlog[0]?.id ?? '', 'new-run')).toBeUndefined()
  expect(records.get(first.id)?.attempt).toBe(1)

  if (state === 'attempting') records.failed(first.id, 1, 'Stopped before writing')
  records.resolve(first.id, 'local_user', 'Checked the composer and handled the old task', false)
  expect(records.due().map((record) => record.id)).toEqual([
    backlog[0]?.id,
    sameWorkspace.id,
    otherWorkspace.id,
  ])
  expect(records.claim(backlog[0]?.id ?? '', 'new-run')?.attempt).toBe(1)
  expect(records.claim(backlog[1]?.id ?? '', 'new-run')).toBeUndefined()
  expect(records.claim(sameWorkspace.id, 'independent-run')?.attempt).toBe(1)
  expect(records.claim(otherWorkspace.id, 'other-workspace-run')?.attempt).toBe(1)
})
