import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { exportBackupDatabase } from '../../src/server/backup-database.js'
import { createMemoryDreamGenerationStore } from '../../src/server/memory-dream-generation-store.js'
import { createMessageLogStore } from '../../src/server/message-log-store.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createTeamMemoryDreamStore } from '../../src/server/team-memory-dream-store.js'
import { createTeamMemoryStore } from '../../src/server/team-memory-store.js'
import type { TeamMemoryDreamRun } from '../../src/shared/team-memory.js'

const databases: Database[] = []
const dirs: string[] = []
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10 })
})
const services = (db: Database) => {
  initializeRuntimeDatabase(db)
  const memory = createTeamMemoryStore(db)
  const dreams = createTeamMemoryDreamStore(db, memory)
  const messages = createMessageLogStore(db)
  const generation = createMemoryDreamGenerationStore(db, memory, dreams, messages)
  const insert = (text: string) =>
    messages.insertMessage({
      workspaceId: 'w',
      workerId: 'w:orchestrator',
      type: 'user_input',
      text,
      createdAt: 10,
    }).sequence
  const claim = () => {
    const prepared = generation.prepare('w')
    if (!prepared) throw new Error('Expected a frozen input')
    const run = generation.claim('w', prepared.id, 'run-1')
    if (!run?.generation?.attempt_id) throw new Error('Expected claimed attempt')
    return run
  }
  const result = (run: TeamMemoryDreamRun, empty = false) => ({
    summary: empty ? 'No reusable fact' : 'One sourced fact',
    candidates: empty
      ? []
      : [
          {
            body: 'Use explicit workspace boundaries.',
            kind: 'decision',
            scope: 'workspace',
            procedure_ref: null,
            tags: ['isolation'],
            source_sequences: [run.generation?.input.messages[0]?.sequence],
          },
        ],
  })
  const complete = (run: TeamMemoryDreamRun, value: unknown = result(run)) => {
    const input = run.generation
    if (!input?.attempt_id || !input.run_id) throw new Error('Expected active attempt')
    return generation.complete('w', run.id, input.run_id, input.attempt_id, input.input_hash, value)
  }
  return { db, memory, dreams, messages, generation, insert, claim, result, complete }
}
const fixture = (path = ':memory:') => {
  const db = new Database(path)
  databases.push(db)
  return services(db)
}

test('empty evidence creates no batch; frozen input survives new arrivals and failure without consuming the cursor', () => {
  const f = fixture()
  expect(f.generation.prepare('w')).toBeNull()
  expect(f.dreams.list('w')).toEqual([])
  const first = f.insert('Keep workspace state isolated.')
  const run = f.claim()
  const second = f.insert('Keep later evidence for the next batch.')
  expect(f.generation.prepare('w')?.id).toBe(run.id)
  expect(run.generation?.input.messages.map((item) => item.sequence)).toEqual([first])
  f.generation.fail('w', run.id, run.generation?.attempt_id ?? '', 'Model unavailable')
  expect(f.generation.cursor('w')).toMatchObject({ sequence: 0, offset: 0 })
  expect(f.generation.claim('w', run.id, 'run-1')).toBeNull()
  const retry = f.generation.claim('w', run.id, 'run-1', { force: true })
  if (!retry) throw new Error('Expected explicit retry')
  expect(retry.generation?.input).toEqual(run.generation?.input)
  expect(() => f.complete(run)).toThrow('attempt or input changed')
  const done = f.complete(retry)
  expect(done.status).toBe('review')
  expect(f.generation.cursor('w').sequence).toBe(first)
  expect(f.memory.list('w')).toEqual([])
  expect(f.complete(retry)).toEqual(done)
  expect(() => f.complete(retry, { ...f.result(retry), summary: 'Different' })).toThrow(
    'different result'
  )
  expect(() => f.generation.prepare('w')).toThrow('existing Dream draft')
  f.dreams.discard('w', done.id, done.planRevision)
  expect(
    f.generation.prepare('w')?.generation?.input.messages.map((item) => item.sequence)
  ).toEqual([second])
})

test('invalid candidate batches and late SQLite failures publish neither candidates nor a consumed cursor', () => {
  const f = fixture()
  f.insert('Keep workspace state isolated.')
  const run = f.claim()
  const before = f.dreams.get('w', run.id)
  const valid = f.result(run)
  const candidate = valid.candidates[0]
  if (!candidate) throw new Error('Expected candidate')
  for (const invalid of [
    { ...valid, candidates: [{ ...candidate, source_sequences: [999999] }] },
    { ...valid, candidates: [candidate, { ...candidate, body: '' }] },
    { ...valid, candidates: [{ ...candidate, scope: 'global' }] },
    { ...valid, summary: '' },
  ])
    expect(() => f.complete(run, invalid)).toThrow()
  expect(f.dreams.get('w', run.id)).toEqual(before)
  f.db.exec(
    "CREATE TRIGGER fail_cursor BEFORE INSERT ON memory_dream_cursors BEGIN SELECT RAISE(ABORT,'cursor disk failure'); END"
  )
  expect(() => f.complete(run)).toThrow('cursor disk failure')
  expect(f.dreams.get('w', run.id)).toEqual(before)
  expect(f.generation.cursor('w').sequence).toBe(0)
  expect(f.memory.list('w')).toEqual([])
  f.db.exec('DROP TRIGGER fail_cursor')
  expect(f.complete(run).operations).toHaveLength(1)
})

test('unfinished generations cannot be changed or applied; human application preserves frozen evidence in its receipt', () => {
  const f = fixture()
  f.insert('Use explicit workspace boundaries.')
  const run = f.claim()
  const actor = { id: 'w:orchestrator', name: 'Reviewer' }
  expect(() => f.dreams.updateOperations('w', run.id, run.planRevision, [])).toThrow('Wait until')
  expect(() => f.dreams.discard('w', run.id, run.planRevision)).toThrow('Wait until')
  expect(() => f.dreams.submit('w', run.id, actor, run.planRevision, [])).toThrow('Wait until')
  const ready = f.complete(run)
  const forged = ready.operations.map((operation) => ({ ...operation, message_sources: [99999] }))
  expect(() => f.dreams.submit('w', run.id, actor, ready.planRevision, forged)).toThrow(
    'frozen input'
  )
  const applied = f.dreams.submit('w', run.id, actor, ready.planRevision)
  expect(f.memory.list('w', { status: 'active' }).map((entry) => entry.body)).toEqual([
    'Use explicit workspace boundaries.',
  ])
  expect(applied?.receipt?.message_evidence).toMatchObject({
    input_hash: ready.generation?.input_hash,
    messages: ready.generation?.input.messages,
  })
  expect(applied?.receipt?.message_evidence?.citations).toEqual([
    { operation_id: ready.operations[0]?.id, sequences: ready.operations[0]?.message_sources },
  ])
  f.dreams.rollback('w', run.id)
  expect(f.memory.list('w', { status: 'active' })).toEqual([])
  expect(f.generation.cursor('w')).toEqual(ready.generation?.input.to)
})

test('an empty model result consumes its window and closes the batch without active memories', () => {
  const f = fixture()
  f.insert('Routine check completed, no durable fact.')
  const run = f.claim()
  const result = f.complete(run, f.result(run, true))
  expect(result).toMatchObject({
    status: 'discarded',
    operations: [],
    generation: { status: 'completed', candidate_count: 0 },
  })
  expect(f.generation.cursor('w')).toEqual(result.generation?.input.to)
  expect(f.generation.prepare('w')).toBeNull()
  expect(f.memory.list('w')).toEqual([])
})

test('restart and database export preserve partial-window leases, candidates and generated cursors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-dream-generation-'))
  dirs.push(dir)
  const path = join(dir, 'runtime.sqlite')
  let f = fixture(path)
  f.insert('A'.repeat(20000))
  const first = f.claim()
  f.db.close()
  f = fixture(path)
  expect(f.generation.prepare('w')?.generation?.input).toEqual(first.generation?.input)
  const resumed = f.generation.claim('w', first.id, 'run-2')
  if (!resumed) throw new Error('Expected reclaimed attempt after restart')
  expect(() => f.complete(first)).toThrow('attempt or input changed')
  const ready = f.complete(resumed)
  const backupPath = join(dir, 'export.sqlite')
  exportBackupDatabase(f.db, backupPath)
  const backup = fixture(backupPath)
  expect(backup.dreams.get('w', first.id)).toEqual(ready)
  expect(backup.generation.cursor('w')).toEqual(ready.generation?.input.to)
  backup.dreams.discard('w', first.id, ready.planRevision)
  const next = backup.generation.prepare('w')
  expect(next?.generation?.input.messages[0]).toMatchObject({
    start_offset: 12000,
    end_offset: 20000,
    text: 'A'.repeat(8000),
  })
})
