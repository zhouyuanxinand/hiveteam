import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createDispatchLedgerStore } from '../../src/server/dispatch-ledger-store.js'
import { createDispatchMessageStore } from '../../src/server/dispatch-message-store.js'
import { createMessageDeliveryStore } from '../../src/server/message-delivery-store.js'
import { createReportOutboxStore } from '../../src/server/report-outbox-store.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

const databases: Database[] = []
const directories: string[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const connect = (path: string) => {
  const db = new Database(path)
  databases.push(db)
  return db
}
const setup = (version: 0 | 1 = 1) => {
  const directory = mkdtempSync(join(tmpdir(), 'hive-task-messages-'))
  directories.push(directory)
  const path = join(directory, 'runtime.sqlite')
  const db = connect(path)
  db.pragma('journal_mode=WAL')
  initializeRuntimeDatabase(db)
  const ledger = createDispatchLedgerStore(db)
  const messages = createDispatchMessageStore(db)
  const workspaceId = randomUUID(),
    workerId = randomUUID(),
    orchestratorId = `${workspaceId}:orchestrator`
  const dispatch = ledger.createDispatch({
    workspaceId,
    toAgentId: workerId,
    text: 'Task',
    messageProtocolVersion: version,
  })
  const send = (actorId: string, body = 'Message') =>
    messages.create(workspaceId, dispatch.id, actorId, { body, kind: 'note' })
  return { path, db, ledger, messages, workspaceId, workerId, orchestratorId, dispatch, send }
}

test('messages persist ordered replies, page without acknowledgement, and leave pending responsibilities unchanged', () => {
  const f = setup()
  const question = f.messages.create(f.workspaceId, f.dispatch.id, f.workerId, {
    kind: 'question',
    body: 'Which API?',
  })
  const answer = f.messages.create(f.workspaceId, f.dispatch.id, f.orchestratorId, {
    kind: 'answer',
    replyTo: question.id,
    body: 'Use v2.',
  })
  const progress = f.messages.create(f.workspaceId, f.dispatch.id, f.workerId, {
    kind: 'progress',
    body: 'Implementing v2.',
  })
  const before = f.db.prepare('SELECT * FROM message_deliveries ORDER BY rowid').all()
  const first = f.messages.list(f.workspaceId, f.dispatch.id, f.workerId, 0, 1)
  expect(first).toMatchObject({
    message_protocol_version: 1,
    required_seen_seq: 2,
    latest_seq: 3,
    next_after: 1,
  })
  expect(first.messages.map((m) => m.id)).toEqual([question.id])
  expect(f.messages.list(f.workspaceId, f.dispatch.id, f.workerId, 1, 1).messages[0]).toMatchObject(
    { id: answer.id, reply_to: question.id }
  )
  expect(f.messages.list(f.workspaceId, f.dispatch.id, f.workerId, 2, 1)).toMatchObject({
    next_after: null,
    messages: [{ id: progress.id }],
  })
  expect(f.db.prepare('SELECT * FROM message_deliveries ORDER BY rowid').all()).toEqual(before)
  expect(f.ledger.countPendingByWorker(f.workspaceId).get(f.workerId)).toBe(1)
})

test.each([
  'message',
  'report',
] as const)('SQLite commit order is authoritative when %s commits first', (first) => {
  const f = setup()
  const second = connect(f.path)
  const otherLedger = createDispatchLedgerStore(second)
  const report = () =>
    otherLedger.markReportedByWorker({
      workspaceId: f.workspaceId,
      toAgentId: f.workerId,
      dispatchId: f.dispatch.id,
      reportText: 'Done',
      artifacts: [],
      seenSeq: 0,
    })
  if (first === 'message') {
    f.send(f.orchestratorId)
    const before = f.ledger.getDispatchById(f.workspaceId, f.dispatch.id)
    expect(report).toThrow(expect.objectContaining({ code: 'stale_seen_seq', statusCode: 409 }))
    expect(f.ledger.getDispatchById(f.workspaceId, f.dispatch.id)).toEqual(before)
    expect(f.ledger.countPendingByWorker(f.workspaceId).get(f.workerId)).toBe(1)
  } else {
    expect(report()).toMatchObject({ status: 'reported', reportRevision: 1 })
    expect(() => f.send(f.orchestratorId)).toThrow(
      expect.objectContaining({ code: 'dispatch_closed' })
    )
    expect(f.messages.list(f.workspaceId, f.dispatch.id, f.workerId).messages).toEqual([])
    expect(f.ledger.countPendingByWorker(f.workspaceId).get(f.workerId) ?? 0).toBe(0)
  }
})

test('message body, scope, replies, and pagination are validated without committing extra records', () => {
  const f = setup()
  const message = f.send(f.orchestratorId)
  const other = f.ledger.createDispatch({
    workspaceId: f.workspaceId,
    toAgentId: f.workerId,
    text: 'Other',
    messageProtocolVersion: 1,
  })
  const foreignQuestion = f.messages.create(f.workspaceId, other.id, f.orchestratorId, {
    kind: 'question',
    body: 'Other question',
  })
  expect(() => f.send(randomUUID())).toThrow(expect.objectContaining({ statusCode: 403 }))
  expect(() => f.messages.list(randomUUID(), f.dispatch.id, f.workerId)).toThrow(
    expect.objectContaining({ statusCode: 404 })
  )
  expect(() => f.messages.list(f.workspaceId, f.dispatch.id, randomUUID())).toThrow(
    expect.objectContaining({ statusCode: 403 })
  )
  expect(() => f.send(f.orchestratorId, '界'.repeat(2731))).toThrow(
    expect.objectContaining({ statusCode: 413 })
  )
  expect(() => f.send(f.orchestratorId, '  ')).toThrow(expect.objectContaining({ statusCode: 400 }))
  for (const replyTo of [message.id, foreignQuestion.id, randomUUID()])
    expect(() =>
      f.messages.create(f.workspaceId, f.dispatch.id, f.workerId, {
        kind: 'answer',
        replyTo,
        body: 'Invalid answer',
      })
    ).toThrow(expect.objectContaining({ statusCode: 400 }))
  expect(() =>
    f.messages.create(f.workspaceId, f.dispatch.id, f.orchestratorId, {
      kind: 'note',
      replyTo: message.id,
      body: 'Own message',
    })
  ).toThrow(expect.objectContaining({ statusCode: 400 }))
  for (const [after, limit] of [
    [-1, 1],
    [0, 101],
    [0, 0],
    [1.1, 1],
  ])
    expect(() => f.messages.list(f.workspaceId, f.dispatch.id, f.workerId, after, limit)).toThrow(
      expect.objectContaining({ statusCode: 400 })
    )
  expect(
    f.messages.list(f.workspaceId, f.dispatch.id, f.workerId).messages.map((m) => m.id)
  ).toEqual([message.id])
  expect(f.send(f.orchestratorId, 'a'.repeat(8192)).sequence).toBe(2)
})

test('legacy dispatches still report without seen_seq and reject protocol-1 messages', () => {
  const f = setup(0)
  expect(() => f.send(f.orchestratorId)).toThrow(
    expect.objectContaining({ code: 'message_protocol_required' })
  )
  expect(f.messages.list(f.workspaceId, f.dispatch.id, f.workerId)).toMatchObject({
    message_protocol_version: 0,
    messages: [],
    required_seen_seq: 0,
  })
  expect(
    f.ledger.markReportedByWorker({
      workspaceId: f.workspaceId,
      toAgentId: f.workerId,
      artifacts: [],
      reportText: 'Legacy done',
    })
  ).toMatchObject({ status: 'reported', reportRevision: 1 })
})

test('a failed delivery insert rolls back the message and sequence allocation', () => {
  const f = setup()
  f.db.exec(
    "CREATE TRIGGER reject_task_message BEFORE INSERT ON message_deliveries WHEN NEW.kind='message' BEGIN SELECT RAISE(ABORT,'delivery unavailable'); END"
  )
  expect(() => f.send(f.orchestratorId)).toThrow('delivery unavailable')
  expect(f.messages.list(f.workspaceId, f.dispatch.id, f.workerId).latest_seq).toBe(0)
  f.db.exec('DROP TRIGGER reject_task_message')
  expect(f.send(f.orchestratorId).sequence).toBe(1)
})

test.each([
  'report',
  'cancel',
] as const)('%s closes unsent messages while preserving uncertain writes and history', (action) => {
  const f = setup()
  const pending = f.send(f.orchestratorId)
  const uncertain = f.send(f.workerId)
  const records = createMessageDeliveryStore(f.db)
  expect(records.claim(uncertain.id, 'run')?.attempt).toBe(1)
  records.beforeWrite(uncertain.id, 1)
  records.submitted(uncertain.id, 1, false)
  if (action === 'report') {
    expect(() =>
      f.ledger.markReportedByWorker({
        workspaceId: f.workspaceId,
        toAgentId: f.workerId,
        artifacts: [],
        reportText: 'Done',
        seenSeq: 99,
      })
    ).toThrow(expect.objectContaining({ statusCode: 400 }))
    f.ledger.markReportedByWorker({
      workspaceId: f.workspaceId,
      toAgentId: f.workerId,
      artifacts: [],
      reportText: 'Done',
      seenSeq: 1,
    })
  } else
    f.ledger.markCancelled({
      workspaceId: f.workspaceId,
      dispatchId: f.dispatch.id,
      reason: 'Cancelled',
    })
  expect(records.get(pending.id)?.state).toBe('resolved')
  expect(records.get(uncertain.id)).toMatchObject({ state: 'unknown', attempt: 1 })
  expect(f.messages.list(f.workspaceId, f.dispatch.id, f.workerId).messages).toHaveLength(2)
})

test.each([
  'pending',
  'unknown',
  'confirmed',
] as const)('new report revisions retain %s receipt evidence and enqueue their own payload', (state) => {
  const f = setup()
  const outbox = createReportOutboxStore(f.db)
  const records = createMessageDeliveryStore(f.db)
  outbox.enqueue({
    dispatchId: f.dispatch.id,
    workspaceId: f.workspaceId,
    targetAgentId: f.orchestratorId,
    payload: 'Original result',
  })
  const old = outbox.listPending(f.workspaceId, f.orchestratorId)[0]
  if (!old) throw new Error('Expected old report')
  if (state !== 'pending') {
    expect(records.claim(old.receiptId, 'report-run')?.attempt).toBe(1)
    records.beforeWrite(old.receiptId, 1)
    records.submitted(old.receiptId, 1, state === 'confirmed')
  }
  outbox.enqueue({
    dispatchId: f.dispatch.id,
    workspaceId: f.workspaceId,
    targetAgentId: f.orchestratorId,
    payload: 'Revised result',
    replacePrevious: true,
  })
  const next = outbox.listPending(f.workspaceId, f.orchestratorId)[0]
  expect(next).toMatchObject({
    payload: 'Revised result',
    deliveryAttemptCount: 0,
    checkpoint: null,
  })
  expect(next?.receiptId).not.toBe(old.receiptId)
  expect(records.get(old.receiptId)?.state).toBe(state === 'pending' ? 'resolved' : state)
  expect(records.get(next?.receiptId ?? '')).toMatchObject({ state: 'pending', attempt: 0 })
  expect(records.events(old.receiptId)).toEqual(
    expect.arrayContaining([expect.objectContaining({ event: 'superseded' })])
  )
  expect(
    f.db
      .prepare(
        "SELECT detail FROM message_delivery_events WHERE delivery_id=? AND event='superseded'"
      )
      .get(old.receiptId)
  ).toEqual({
    detail: JSON.stringify({ next_receipt_id: next?.receiptId, payload: 'Original result' }),
  })
})
