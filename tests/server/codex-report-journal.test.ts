import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, test } from 'vitest'
import {
  assertReportSession,
  createReportJournalReader,
  findReportSession,
  reportJournalOffset,
} from '../../src/server/codex-report-journal.js'
import { reportReceiptMarker } from '../../src/server/report-delivery-receipt.js'
import { applySchemaVersion47 } from '../../src/server/sqlite-schema-v47.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-report-journal-'))
  dirs.push(dir)
  const sessions = join(dir, 'sessions')
  mkdirSync(sessions)
  const id = randomUUID()
  const file = join(sessions, `rollout-test-${id}.jsonl`)
  writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: dir } })}\n`)
  return {
    dir,
    file,
    id,
    marker: reportReceiptMarker(randomUUID()),
    pattern: `${sessions}/**/*.jsonl`,
  }
}

test.each([
  'response_item',
  'event_msg',
])('accepts only the tagged user input (%s), including partial UTF-8 JSONL writes', (type) => {
  const { dir, file, id, marker, pattern } = setup()
  expect(findReportSession(pattern, id, dir)).toBe(file)
  const offset = reportJournalOffset(file)
  const scan = createReportJournalReader(file, offset, marker)
  for (const role of ['assistant', 'tool'])
    appendFileSync(
      file,
      `${JSON.stringify({ type: 'response_item', payload: { role, content: [{ type: 'input_text', text: marker }] } })}\n`
    )
  appendFileSync(
    file,
    `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', message: marker } })}\n`
  )
  expect(scan()).toEqual({ found: false, caughtUp: true })
  const completeOffset = reportJournalOffset(file)
  const record = {
    type,
    payload:
      type === 'response_item'
        ? { role: 'user', content: [{ type: 'input_text', text: `汇报 ${marker}` }] }
        : { type: 'user_message', message: `汇报 ${marker}` },
  }
  const buffer = Buffer.from(`${JSON.stringify(record)}\n`)
  const split = buffer.indexOf(Buffer.from('汇')) + 1
  appendFileSync(file, buffer.subarray(0, split))
  expect(scan()).toEqual({ found: false, caughtUp: false })
  expect(reportJournalOffset(file)).toBe(completeOffset)
  appendFileSync(file, buffer.subarray(split))
  expect(scan().found).toBe(true)
})

test('rejects another member session and fails closed on a truncated journal', () => {
  const { dir, file, id, marker } = setup()
  expect(() => assertReportSession(file, randomUUID(), dir)).toThrow('does not match')
  expect(() => assertReportSession(file, id, join(dir, 'other'))).toThrow('does not match')
  const scan = createReportJournalReader(file, reportJournalOffset(file), marker)
  writeFileSync(file, '')
  expect(() => scan()).toThrow('truncated')
})

test('receipt checkpoints can scan past a large tool response without accepting its quoted marker', () => {
  const { file, marker } = setup()
  const scan = createReportJournalReader(file, reportJournalOffset(file), marker)
  appendFileSync(
    file,
    `${JSON.stringify({ type: 'response_item', payload: { role: 'tool', content: 'x'.repeat(600_000) + marker } })}\n`
  )
  appendFileSync(
    file,
    `${JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: marker } })}\n`
  )
  expect(scan()).toEqual({ found: false, caughtUp: false })
  expect(scan()).toEqual({ found: false, caughtUp: false })
  expect(scan().found).toBe(true)
})

test('migration preserves historical delivery decisions and keeps pending receipt IDs stable across reopen', () => {
  const { dir } = setup()
  const path = join(dir, 'queue.sqlite')
  let db = new Database(path)
  db.exec(
    'CREATE TABLE report_outbox (id INTEGER PRIMARY KEY, delivered_at INTEGER); INSERT INTO report_outbox VALUES (1, NULL), (2, 123)'
  )
  applySchemaVersion47(db)
  const first = db.prepare('SELECT * FROM report_outbox ORDER BY id').all()
  db.close()
  db = new Database(path)
  try {
    applySchemaVersion47(db)
    expect(db.prepare('SELECT * FROM report_outbox ORDER BY id').all()).toEqual(first)
    expect(first).toEqual([
      {
        id: 1,
        delivered_at: null,
        receipt_id: expect.stringMatching(/^[\da-f-]{36}$/),
        delivery_checkpoint: null,
      },
      {
        id: 2,
        delivered_at: 123,
        receipt_id: expect.stringMatching(/^[\da-f-]{36}$/),
        delivery_checkpoint: null,
      },
    ])
  } finally {
    db.close()
  }
})
