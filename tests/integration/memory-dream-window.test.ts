import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { ConflictError } from '../../src/server/http-errors.js'
import type { DreamMessageCursor } from '../../src/server/memory-dream-message-window.js'
import { createMessageLogStore, type MessageLogRecord } from '../../src/server/message-log-store.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createAttentionFixture } from '../helpers/attention-fixture.js'

const databases: Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
const fixture = () => {
  const db = new Database(':memory:')
  databases.push(db)
  initializeRuntimeDatabase(db)
  const messages = createMessageLogStore(db)
  const insert = (text: string, patch: Partial<MessageLogRecord> = {}) =>
    messages.insertMessage({
      workspaceId: 'workspace',
      workerId: 'worker',
      fromAgentId: 'worker',
      type: 'report',
      createdAt: 10,
      text,
      ...patch,
    }).sequence
  return { db, messages, insert }
}
const start: DreamMessageCursor = { sequence: 0, offset: 0 }

test('reads only conversation evidence with stable sequences, workspace isolation and a twenty-message bound', () => {
  const f = fixture()
  f.insert('Private other workspace', { workspaceId: 'other' })
  f.insert('System setup', { type: 'system_env_sync' })
  f.insert('Recovery prompt', { type: 'system_recovery_summary' })
  f.insert('Template without recognizable magic prefix', {
    type: 'send',
    purpose: 'memory_dream_review',
  })
  f.insert('System copied status', { type: 'status', toAgentId: 'worker' })
  f.insert('Not a worker status', { type: 'status', fromAgentId: 'orchestrator' })
  f.insert('  \n\t', { type: 'feedback' })
  const legacy = f.insert('Old report with unknown purpose')
  f.db.prepare("UPDATE messages SET purpose='legacy' WHERE sequence=?").run(legacy)
  const types = ['user_input', 'send', 'report', 'feedback', 'member_feedback', 'status'] as const
  const ids = Array.from({ length: 23 }, (_, i) => {
    f.insert('Gap', { workspaceId: 'other' })
    return f.insert(`Evidence ${i}`, {
      type: types[i % types.length] ?? 'user_input',
      createdAt: 10,
    })
  })
  expect(f.messages.hasDreamMessages('workspace', start)).toBe(true)
  const first = f.messages.readDreamWindow('workspace', start)
  expect(first?.messages.map((message) => message.sequence)).toEqual(ids.slice(0, 20))
  expect(first?.messages.map((message) => message.type)).toEqual(
    Array.from({ length: 20 }, (_, i) => types[i % types.length])
  )
  expect(first?.to).toEqual({ sequence: ids[19], offset: 0, source_hash: null })
  if (!first) throw new Error('Expected first window')
  const second = f.messages.readDreamWindow('workspace', first.to)
  expect(second?.messages.map((message) => message.sequence)).toEqual(ids.slice(20))
  if (!second) throw new Error('Expected second window')
  expect(f.messages.hasDreamMessages('workspace', second.to)).toBe(false)
  expect(f.messages.readDreamWindow('workspace', second.to)).toBeNull()
  expect(f.messages.readDreamWindow('missing', start)).toBeNull()
})

test('fragments long evidence without dropping text or splitting a UTF-16 surrogate pair', () => {
  const f = fixture()
  const text = `${'A'.repeat(11_999)}😀${'B'.repeat(14_001)}`
  const id = f.insert(text)
  let cursor = start
  const fragments: string[] = []
  const hashes: string[] = []
  let windows = 0
  while (f.messages.hasDreamMessages('workspace', cursor)) {
    const window = f.messages.readDreamWindow('workspace', cursor)
    if (!window) throw new Error('Expected remaining evidence')
    expect(window.messages).toHaveLength(1)
    const message = window.messages[0]
    if (!message) throw new Error('Expected fragment')
    expect(message.sequence).toBe(id)
    expect(message.total_chars).toBe(text.length)
    expect(message.start_offset).toBe(cursor.offset)
    expect(message.text.length).toBeLessThanOrEqual(12_000)
    expect(message.end_offset - message.start_offset).toBe(message.text.length)
    if (windows === 0) expect(message.end_offset).toBe(11_999)
    if (windows === 1) expect(message.text.startsWith('😀')).toBe(true)
    fragments.push(message.text)
    hashes.push(message.content_hash)
    cursor = window.to
    windows += 1
  }
  expect(windows).toBe(3)
  expect(new Set(hashes).size).toBe(1)
  expect(fragments.join('')).toBe(text)
  expect(cursor).toEqual({ sequence: id, offset: 0, source_hash: null })
})

test('a window preserves its upper boundary when new evidence arrives and caps the combined text budget', () => {
  const f = fixture()
  const a = f.insert('A'.repeat(7000))
  const b = f.insert('B'.repeat(7000))
  const first = f.messages.readDreamWindow('workspace', start)
  if (!first) throw new Error('Expected window')
  expect(first.messages.map((message) => [message.sequence, message.text.length])).toEqual([
    [a, 7000],
    [b, 5000],
  ])
  expect(first.to).toMatchObject({ sequence: b, offset: 5000 })
  const c = f.insert('Arrived during generation')
  const second = f.messages.readDreamWindow('workspace', first.to)
  expect(second?.messages.map((message) => [message.sequence, message.start_offset])).toEqual([
    [b, 5000],
    [c, 0],
  ])
  expect(first.messages.map((message) => message.sequence)).toEqual([a, b])
  if (!second) throw new Error('Expected remaining window')
  const d = f.insert('D'.repeat(11_999))
  const e = f.insert('😀')
  const third = f.messages.readDreamWindow('workspace', second.to)
  expect(third?.messages.map((message) => message.sequence)).toEqual([d])
  expect(third?.to).toEqual({ sequence: d, offset: 0, source_hash: null })
  if (!third) throw new Error('Expected bounded window')
  expect(f.messages.readDreamWindow('workspace', third.to)?.messages).toEqual([
    expect.objectContaining({ sequence: e, text: '😀', start_offset: 0, end_offset: 2 }),
  ])
})

test('changed, deleted, moved or repurposed partial evidence conflicts instead of skipping its remainder', () => {
  const f = fixture()
  const id = f.insert('A'.repeat(13_000))
  const first = f.messages.readDreamWindow('workspace', start)
  if (!first) throw new Error('Expected partial evidence')
  f.insert('Later evidence must not hide a cursor conflict')
  const expectConflict = () => {
    expect(() => f.messages.readDreamWindow('workspace', first.to)).toThrow(ConflictError)
    expect(() => f.messages.hasDreamMessages('workspace', first.to)).toThrow(ConflictError)
  }
  f.db.prepare('UPDATE messages SET text=? WHERE sequence=?').run('B'.repeat(13_000), id)
  expectConflict()
  f.db.prepare('UPDATE messages SET text=? WHERE sequence=?').run('A'.repeat(13_000), id)
  expect(f.messages.readDreamWindow('workspace', first.to)?.messages[0]?.text).toBe(
    'A'.repeat(1000)
  )
  f.db.prepare("UPDATE messages SET purpose='memory_dream_review' WHERE sequence=?").run(id)
  expectConflict()
  f.db
    .prepare("UPDATE messages SET purpose='conversation',workspace_id='other' WHERE sequence=?")
    .run(id)
  expectConflict()
  f.db.prepare('DELETE FROM messages WHERE sequence=?').run(id)
  expectConflict()
})

test('partial cursors require a matching source hash and complete consumption resumes after its sequence', () => {
  const f = fixture()
  const id = f.insert('X'.repeat(12_001))
  const window = f.messages.readDreamWindow('workspace', start)
  if (!window) throw new Error('Expected partial window')
  expect(() => f.messages.readDreamWindow('workspace', { sequence: id, offset: 12_000 })).toThrow(
    ConflictError
  )
  expect(() => f.messages.readDreamWindow('other', window.to)).toThrow(ConflictError)
  const tail = f.messages.readDreamWindow('workspace', window.to)
  expect(tail?.messages[0]?.text).toBe('X')
  if (!tail) throw new Error('Expected tail')
  expect(f.messages.readDreamWindow('workspace', tail.to)).toBeNull()
})

test('dispatch purpose propagates through real persisted send, status, feedback and report records', async () => {
  const f = await createAttentionFixture()
  try {
    f.server.store.configureAgentLaunch(f.workspace.id, f.worker.id, {
      command: process.execPath,
      args: ['-e', 'process.stdin.resume()'],
    })
    await f.server.store.startAgent(f.workspace.id, f.worker.id, { hivePort: '4010' })
    f.server.store.memory.create(f.workspace.id, { kind: 'fact', body: 'Review basis' })
    const dream = f.server.store.memoryDream.create(f.workspace.id)
    const dispatch = await f.server.store.dispatchTask(
      f.workspace.id,
      f.worker.id,
      'A generated review template',
      {
        messagePurpose: 'memory_dream_review',
        onCreated: (created) => {
          f.server.store.memoryDream.recordReviewRequest(
            f.workspace.id,
            dream.id,
            f.worker.id,
            created.id
          )
        },
      }
    )
    f.server.store.statusTask(f.workspace.id, f.worker.id, {
      dispatchId: dispatch.id,
      text: 'Review progress',
    })
    f.server.store.statusTask(f.workspace.id, f.worker.id, { text: 'Unambiguous review progress' })
    f.server.store.sendDispatchFeedback(f.workspace.id, dispatch.id, 'Generated review feedback')
    f.server.store.reportTask(f.workspace.id, f.worker.id, {
      dispatchId: dispatch.id,
      text: 'Generated review report',
    })
    const rows = f.db
      .prepare('SELECT type,purpose,text FROM messages WHERE workspace_id=? ORDER BY sequence')
      .all(f.workspace.id)
    expect(rows).toEqual([
      { type: 'send', purpose: 'memory_dream_review', text: 'A generated review template' },
      { type: 'status', purpose: 'memory_dream_review', text: 'Review progress' },
      { type: 'status', purpose: 'memory_dream_review', text: 'Unambiguous review progress' },
      { type: 'feedback', purpose: 'memory_dream_review', text: 'Generated review feedback' },
      { type: 'report', purpose: 'memory_dream_review', text: 'Generated review report' },
    ])
    const messages = createMessageLogStore(f.db)
    expect(messages.readDreamWindow(f.workspace.id, start)).toBeNull()
    const normal = await f.task('Normal factual task')
    f.server.store.reportTask(f.workspace.id, f.worker.id, {
      dispatchId: normal.id,
      text: 'Normal factual report',
    })
    expect(
      messages.readDreamWindow(f.workspace.id, start)?.messages.map((message) => message.text)
    ).toEqual(['Normal factual task', 'Normal factual report'])
  } finally {
    await f.close()
  }
}, 30_000)

test('child dispatches inherit Dream purpose through persisted ancestry and reject unrelated parent actors or workspaces', async () => {
  const f = await createAttentionFixture()
  try {
    f.server.store.memory.create(f.workspace.id, { kind: 'fact', body: 'Review basis' })
    const dream = f.server.store.memoryDream.create(f.workspace.id)
    const parent = await f.server.store.dispatchTask(f.workspace.id, f.worker.id, 'Root review', {
      messagePurpose: 'memory_dream_review',
      onCreated: (created) => {
        f.server.store.memoryDream.recordReviewRequest(
          f.workspace.id,
          dream.id,
          f.worker.id,
          created.id
        )
      },
    })
    const child = await f.server.store.dispatchTask(f.workspace.id, f.worker.id, 'Child review', {
      parentDispatchId: parent.id,
    })
    const grandchild = await f.server.store.dispatchTask(
      f.workspace.id,
      f.worker.id,
      'Grandchild review',
      {
        parentDispatchId: child.id,
        messagePurpose: 'conversation',
      }
    )
    f.server.store.statusTask(f.workspace.id, f.worker.id, {
      dispatchId: grandchild.id,
      text: 'Child review status',
    })
    f.server.store.reportTask(f.workspace.id, f.worker.id, {
      dispatchId: grandchild.id,
      text: 'Child review report',
    })
    const before = f.db
      .prepare('SELECT sequence,purpose,text FROM messages WHERE workspace_id=? ORDER BY sequence')
      .all(f.workspace.id)
    expect(before).toHaveLength(5)
    expect(before).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ purpose: 'memory_dream_review', text: 'Child review' }),
        expect.objectContaining({ purpose: 'memory_dream_review', text: 'Grandchild review' }),
        expect.objectContaining({ purpose: 'memory_dream_review', text: 'Child review status' }),
        expect.objectContaining({ purpose: 'memory_dream_review', text: 'Child review report' }),
      ])
    )
    const stranger = f.server.store.addWorker(f.workspace.id, {
      name: 'Unrelated member',
      role: 'coder',
    })
    await expect(
      f.server.store.dispatchTask(f.workspace.id, f.worker.id, 'Forbidden child', {
        parentDispatchId: parent.id,
        fromAgentId: stranger.id,
      })
    ).rejects.toMatchObject({ statusCode: 403 })
    const other = f.server.store.createWorkspace(join(f.server.dataDir, 'other'), 'Other')
    const otherWorker = f.server.store.addWorker(other.id, { name: 'Other worker', role: 'coder' })
    await expect(
      f.server.store.dispatchTask(other.id, otherWorker.id, 'Foreign parent', {
        parentDispatchId: parent.id,
      })
    ).rejects.toMatchObject({ statusCode: 409 })
    expect(
      f.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE workspace_id=?').get(other.id)
    ).toEqual({ count: 0 })
    expect(
      f.db
        .prepare(
          'SELECT sequence,purpose,text FROM messages WHERE workspace_id=? ORDER BY sequence'
        )
        .all(f.workspace.id)
    ).toEqual(before)
    const messages = createMessageLogStore(f.db)
    expect(messages.readDreamWindow(f.workspace.id, start)).toBeNull()
  } finally {
    await f.close()
  }
}, 30_000)

test('schema 66 preserves legacy user evidence without guessing the purpose of old agent messages', () => {
  const f = fixture()
  f.insert('Existing user decision', { type: 'user_input' })
  f.insert('Existing human feedback', { type: 'member_feedback' })
  f.insert('Old generated or normal report')
  f.insert('Old generated or normal send', { type: 'send' })
  f.insert('Old setup', { type: 'system_env_sync' })
  f.db.exec(
    'DROP INDEX idx_messages_dream_window; ALTER TABLE messages DROP COLUMN purpose; DELETE FROM schema_version WHERE version=66'
  )
  initializeRuntimeDatabase(f.db)
  initializeRuntimeDatabase(f.db)
  expect(
    f.db.prepare('SELECT COUNT(*) AS count FROM schema_version WHERE version=66').get()
  ).toEqual({ count: 1 })
  expect(f.db.prepare('SELECT type,purpose FROM messages ORDER BY sequence').all()).toEqual([
    { type: 'user_input', purpose: 'conversation' },
    { type: 'member_feedback', purpose: 'conversation' },
    { type: 'report', purpose: 'legacy' },
    { type: 'send', purpose: 'legacy' },
    { type: 'system_env_sync', purpose: 'legacy' },
  ])
  const messages = createMessageLogStore(f.db)
  expect(
    messages.readDreamWindow('workspace', start)?.messages.map((message) => message.text)
  ).toEqual(['Existing user decision', 'Existing human feedback'])
  messages.insertMessage({
    workspaceId: 'workspace',
    workerId: 'worker',
    fromAgentId: 'worker',
    type: 'report',
    text: 'New report',
    createdAt: 20,
  })
  initializeRuntimeDatabase(f.db)
  expect(
    messages.readDreamWindow('workspace', start)?.messages.map((message) => message.text)
  ).toEqual(['Existing user decision', 'Existing human feedback', 'New report'])
})
