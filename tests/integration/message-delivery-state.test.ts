import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createDispatchHealthStore } from '../../src/server/dispatch-health-store.js'
import { createDispatchLedgerStore } from '../../src/server/dispatch-ledger-store.js'
import { createMessageDeliveryStore } from '../../src/server/message-delivery-store.js'
import { createReportOutboxStore } from '../../src/server/report-outbox-store.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

const databases: Database.Database[] = []
const dirs: string[] = []
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const setup = (file = ':memory:') => {
  const db = new Database(file)
  databases.push(db)
  initializeRuntimeDatabase(db)
  const ledger = createDispatchLedgerStore(db)
  const workspaceId = randomUUID(),
    workerId = randomUUID()
  const dispatch = () =>
    ledger.createDispatch({ workspaceId, toAgentId: workerId, text: 'Implement a task' })
  return { db, ledger, workspaceId, workerId, dispatch }
}

test('claims serialize one composer; uncertain input blocks only its recipient and cannot be retried by a wake', () => {
  const f = setup()
  let now = Date.now() + 1000
  const store = createMessageDeliveryStore(f.db, () => now)
  const first = f.dispatch(),
    second = f.dispatch()
  const other = f.ledger.createDispatch({
    workspaceId: f.workspaceId,
    toAgentId: randomUUID(),
    text: 'Independent task',
  })
  expect(store.claim(first.id, 'run-one')?.attempt).toBe(1)
  expect(store.claim(second.id, 'run-one')).toBeUndefined()
  expect(store.claim(other.id, 'run-other')?.attempt).toBe(1)
  store.beforeWrite(first.id, 1)
  store.failed(first.id, 1, 'Exited after paste')
  now += 1_000_000
  expect(store.get(first.id)).toMatchObject({ state: 'unknown', write_started: 1 })
  expect(store.claim(first.id, 'replacement-run')).toBeUndefined()
  expect(store.claim(second.id, 'replacement-run')).toBeUndefined()
  store.resolve(first.id, 'local_user', 'Reviewed the old session and cleared the composer', false)
  expect(store.claim(second.id, 'replacement-run')?.attempt).toBe(1)
  expect(store.events(first.id)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ event: 'manual_resolution', actor: 'local_user' }),
    ])
  )
})

test('database reopen distinguishes an unattempted write from an uncertain write, preserving checkpoints and attempt IDs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-delivery-state-'))
  dirs.push(dir)
  const file = join(dir, 'runtime.sqlite'),
    f = setup(file),
    now = Date.now() + 1000
  const store = createMessageDeliveryStore(f.db, () => now)
  const first = f.dispatch()
  store.claim(first.id, 'old-run')
  const second = f.ledger.createDispatch({
    workspaceId: f.workspaceId,
    toAgentId: randomUUID(),
    text: 'second',
  })
  store.claim(second.id, 'other-run')
  const checkpoint = {
    cwd: dir,
    inputSequence: 1,
    lastSubmitAt: now,
    offset: 10,
    pasteConfirmed: true,
    runId: 'other-run',
    sessionFile: join(dir, 'synthetic.jsonl'),
    sessionId: randomUUID(),
    submitAttempts: 1,
  }
  store.saveCheckpoint(second.id, 1, checkpoint)
  f.db.close()
  const db = new Database(file)
  databases.push(db)
  initializeRuntimeDatabase(db)
  const recovered = createMessageDeliveryStore(db, () => now + 60_000)
  recovered.recover()
  expect(recovered.get(first.id)).toMatchObject({ state: 'pending', attempt: 1 })
  expect(recovered.get(second.id)).toMatchObject({
    state: 'unknown',
    attempt: 1,
    checkpoint: JSON.stringify(checkpoint),
  })
  expect(recovered.claim(second.id, 'fresh-run')).toBeUndefined()
  recovered.resolve(
    second.id,
    'local_user',
    'Checked the old session; explicitly repeat the task',
    true
  )
  expect(recovered.claim(second.id, 'fresh-run')).toMatchObject({
    attempt: 2,
    checkpoint: null,
    id: second.id,
  })
  expect(recovered.events(second.id)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ event: 'explicit_resend', attempt: 1, actor: 'local_user' }),
    ])
  )
})

test('receipt migration preserves pending counts and historical delivered timestamps without fabricating native acceptance', () => {
  const f = setup(),
    first = f.dispatch(),
    second = f.dispatch()
  f.ledger.markSubmitted(first.id)
  const outbox = createReportOutboxStore(f.db)
  outbox.enqueue({
    workspaceId: f.workspaceId,
    targetAgentId: `${f.workspaceId}:orchestrator`,
    dispatchId: second.id,
    payload: 'report',
  })
  const entry = outbox.listPending(f.workspaceId, `${f.workspaceId}:orchestrator`)[0]
  if (!entry) throw new Error('Expected persisted report')
  outbox.markDelivered(entry.id)
  const before = f.ledger.countPendingByWorker(f.workspaceId)
  // Recreate the pre-52 transport boundary while keeping real dispatch/outbox history.
  f.db.exec(
    'DROP TRIGGER dispatch_delivery_created; DROP TRIGGER report_delivery_created; DROP TRIGGER report_delivery_removed; DROP TABLE message_delivery_events; DROP TABLE message_deliveries; DROP TABLE dispatch_health_events; DROP TABLE dispatch_health; DELETE FROM schema_version WHERE version=52;'
  )
  initializeRuntimeDatabase(f.db)
  const records = createMessageDeliveryStore(f.db)
  expect(records.get(first.id)).toMatchObject({
    state: 'unknown',
    evidence: 'legacy_unknown',
    confirmed_at: null,
  })
  expect(records.get(entry.receiptId)).toMatchObject({
    state: 'resolved',
    evidence: 'legacy_unknown',
    confirmed_at: null,
  })
  expect(f.ledger.countPendingByWorker(f.workspaceId)).toEqual(before)
  const health = createDispatchHealthStore(f.db)
  const migratedTimeouts = health.get(first.id)?.timeouts
  health.configure(f.workspaceId, { execution_ms: 7000 }, 'local_user')
  expect(health.get(first.id)?.timeouts).toEqual(migratedTimeouts)
  expect(health.settings(f.workspaceId).execution_ms).toBe(7000)
  expect(
    f.db.prepare('SELECT delivered_at FROM report_outbox WHERE id=?').get(entry.id)
  ).toMatchObject({ delivered_at: expect.any(Number) })
})

test('health deadlines survive reopen; structured waiting suppresses inactivity and cancellation never consumes another task', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hive-health-reopen-'))
  dirs.push(directory)
  const file = join(directory, 'runtime.sqlite')
  const f = setup(file)
  let now = 100_000
  const health = createDispatchHealthStore(f.db, () => now)
  const first = f.dispatch(),
    second = f.dispatch()
  health.configure(
    f.workspaceId,
    { delivery_ms: 100, execution_ms: 2000, inactivity_ms: 1000, cancellation_ms: 1000 },
    'local_user',
    first.id
  )
  health.start(first.id, 'submission_estimate')
  now += 1500
  health.tick()
  expect(health.get(first.id)?.reasons).toEqual(['no_progress'])
  const notificationCount = health.events(first.id).length
  health.tick()
  expect(health.events(first.id)).toHaveLength(notificationCount)
  health.progress(f.workspaceId, first.id, f.workerId, 'waiting_permission')
  health.tick()
  expect(health.get(first.id)?.reasons).toEqual([])
  now += 1000
  f.db.close()
  f.db = new Database(file)
  databases.push(f.db)
  initializeRuntimeDatabase(f.db)
  f.ledger = createDispatchLedgerStore(f.db)
  const recovered = createDispatchHealthStore(f.db, () => now)
  recovered.tick()
  expect(recovered.get(first.id)).toMatchObject({
    started_at: 100_000,
    start_source: 'submission_estimate',
    reasons: ['execution_overdue'],
    waiting_reason: 'waiting_permission',
  })
  f.ledger.markCancelled({
    workspaceId: f.workspaceId,
    dispatchId: first.id,
    reason: 'Stop only this task',
  })
  recovered.cancel(first.id)
  now += 1001
  recovered.tick()
  expect(recovered.get(first.id)?.reasons).toEqual(['cancellation_unconfirmed'])
  const count = f.ledger.countPendingByWorker(f.workspaceId)
  recovered.lateReport(f.workspaceId, first.id, f.workerId, { text: 'Late result' })
  expect(f.ledger.countPendingByWorker(f.workspaceId)).toEqual(count)
  expect(f.ledger.getDispatchById(f.workspaceId, second.id)?.status).toBe('queued')
  recovered.confirmCancellation(f.workspaceId, first.id, f.workerId, 'worker_ack', f.workerId)
  expect(recovered.get(first.id)).toMatchObject({ cancellation_source: 'worker_ack', reasons: [] })
})

test('pre-write failures have bounded backoff and require manual recovery after five attempts', () => {
  const f = setup()
  let now = Date.now() + 1000
  const records = createMessageDeliveryStore(f.db, () => now)
  const first = f.dispatch(),
    second = f.dispatch()
  for (let attempt = 1; attempt <= 5; attempt++) {
    expect(records.claim(first.id, 'run')?.attempt).toBe(attempt)
    records.failed(first.id, attempt, 'Composer not ready; no bytes written')
    expect(records.get(first.id)?.write_started).toBe(0)
    expect(records.claim(second.id, 'run')).toBeUndefined()
    if (attempt < 5) {
      const delay = 1000 * 2 ** (attempt - 1)
      expect(records.get(first.id)?.next_attempt_at).toBe(now + delay)
      now += delay - 1
      expect(records.claim(first.id, 'run')).toBeUndefined()
      now++
    }
  }
  now += 60_000
  expect(records.get(first.id)?.state).toBe('manual')
  expect(records.claim(first.id, 'run')).toBeUndefined()
  records.resolve(first.id, 'local_user', 'Cleared composer and chose to retry', true)
  expect(records.claim(first.id, 'run')?.attempt).toBe(6)
  records.beforeWrite(first.id, 6)
  records.failed(first.id, 6, 'PTY exited after input')
  now += 1_000_000
  expect(records.get(first.id)).toMatchObject({ state: 'unknown', write_started: 1 })
  expect(records.claim(first.id, 'new-run')).toBeUndefined()
})

test('failed audit writes roll back the claim and workspace reminder changes', () => {
  const f = setup(),
    task = f.dispatch()
  const records = createMessageDeliveryStore(f.db, () => Date.now() + 1000)
  f.db.exec(
    "CREATE TRIGGER fail_delivery_event BEFORE INSERT ON message_delivery_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END"
  )
  expect(() => records.claim(task.id, 'run')).toThrow('audit unavailable')
  expect(records.get(task.id)).toMatchObject({ state: 'pending', attempt: 0, run_id: null })
  const health = createDispatchHealthStore(f.db)
  const before = health.settings(f.workspaceId)
  f.db.exec(
    "CREATE TRIGGER fail_settings_event BEFORE INSERT ON dispatch_timeout_events BEGIN SELECT RAISE(ABORT,'settings audit unavailable'); END"
  )
  expect(() => health.configure(f.workspaceId, { execution_ms: 9000 }, 'local_user')).toThrow(
    'settings audit unavailable'
  )
  expect(health.settings(f.workspaceId)).toEqual(before)
})
