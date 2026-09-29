import { join } from 'node:path'
import { expect, test } from 'vitest'
import { exportBackupDatabase } from '../../src/server/backup-database.js'
import { ConflictError } from '../../src/server/http-errors.js'
import { createMemoryDreamGenerationStore } from '../../src/server/memory-dream-generation-store.js'
import { createMessageLogStore } from '../../src/server/message-log-store.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createTeamMemoryDreamStore } from '../../src/server/team-memory-dream-store.js'
import { createTeamMemoryStore } from '../../src/server/team-memory-store.js'
import type { TeamMemoryDreamRun } from '../../src/shared/team-memory.js'
import { createAttentionFixture } from '../helpers/attention-fixture.js'

const fixture = async () => {
  const f = await createAttentionFixture()
  const store = f.server.store
  const generation = store.memoryDreamGeneration
  const claim = () => {
    const draft = generation.prepare(f.workspace.id)
    if (!draft) throw new Error('Expected generation')
    const run = generation.claim(f.workspace.id, draft.id, 'generator-run')
    if (!run) throw new Error('Expected claimed generation')
    return run
  }
  const complete = (run: TeamMemoryDreamRun) => {
    const g = run.generation
    if (!g?.run_id || !g.attempt_id) throw new Error('Expected attempt')
    return generation.complete(f.workspace.id, run.id, g.run_id, g.attempt_id, g.input_hash, {
      candidates: [],
      summary: 'No durable facts',
    })
  }
  const remove = () =>
    fetch(`${f.server.baseUrl}/api/workspaces/${f.workspace.id}/workers/${f.worker.id}`, {
      method: 'DELETE',
      headers: { cookie: f.cookie },
    })
  const status = (text: string) => store.statusTask(f.workspace.id, f.worker.id, { text })
  const addNextEvidence = () => {
    const next = store.addWorker(f.workspace.id, { name: 'Next member', role: 'coder' })
    store.statusTask(f.workspace.id, next.id, { text: 'New evidence after removal' })
  }
  return { ...f, store, generation, claim, complete, remove, status, addNextEvidence }
}

test('deleting a member skips only its authorized partial remainder and leaves the next batch usable after backup', async () => {
  const f = await fixture()
  try {
    f.status('A'.repeat(20_000))
    f.complete(f.claim())
    const cursor = f.generation.cursor(f.workspace.id)
    expect(cursor.offset).toBe(12_000)
    expect((await f.remove()).status).toBe(204)
    expect(
      f.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE worker_id=?').get(f.worker.id)
    ).toEqual({ count: 0 })
    expect(f.generation.hasPendingEvidence(f.workspace.id)).toBe(false)
    expect(f.generation.prepare(f.workspace.id)).toBeNull()
    f.addNextEvidence()
    const path = join(f.server.dataDir, 'deleted-source-backup.sqlite')
    exportBackupDatabase(f.db, path)
    const db = new Database(path)
    try {
      initializeRuntimeDatabase(db)
      const memory = createTeamMemoryStore(db)
      const dreams = createTeamMemoryDreamStore(db, memory)
      const generation = createMemoryDreamGenerationStore(
        db,
        memory,
        dreams,
        createMessageLogStore(db)
      )
      expect(
        generation
          .prepare(f.workspace.id)
          ?.generation?.input.messages.map((message) => message.text)
      ).toEqual(['New evidence after removal'])
    } finally {
      db.close()
    }
    const next = f.claim()
    expect(next.generation?.input.from).toEqual(cursor)
    expect(next.generation?.input.messages.map((message) => message.text)).toEqual([
      'New evidence after removal',
    ])
    f.complete(next)
    expect(f.generation.cursor(f.workspace.id).offset).toBe(0)
    expect(f.generation.hasPendingEvidence(f.workspace.id)).toBe(false)
    expect(f.store.memory.list(f.workspace.id)).toEqual([])
  } finally {
    await f.close()
  }
})

test('deletion preserves an in-flight batch from one partial message to another without invalidating completion', async () => {
  const f = await fixture()
  try {
    f.status('A'.repeat(13_000))
    f.status('B'.repeat(20_000))
    f.complete(f.claim())
    const pending = f.claim()
    expect(pending.generation?.input.from.offset).toBe(12_000)
    expect(pending.generation?.input.to.offset).toBe(11_000)
    expect(pending.generation?.input.from.sequence).not.toBe(pending.generation?.input.to.sequence)
    const cursor = f.generation.cursor(f.workspace.id)
    expect((await f.remove()).status).toBe(204)
    expect(f.generation.cursor(f.workspace.id)).toEqual(cursor)
    expect(f.generation.prepare(f.workspace.id)?.generation?.input).toEqual(
      pending.generation?.input
    )
    f.complete(pending)
    f.addNextEvidence()
    const next = f.claim()
    expect(next.generation?.input.messages.map((message) => message.text)).toEqual([
      'New evidence after removal',
    ])
    f.complete(next)
    expect(f.generation.prepare(f.workspace.id)).toBeNull()
  } finally {
    await f.close()
  }
})

test('authorized deletion does not hide previously changed evidence with a mismatched source hash', async () => {
  const f = await fixture()
  try {
    f.status('A'.repeat(20_000))
    f.complete(f.claim())
    const cursor = f.generation.cursor(f.workspace.id)
    f.db
      .prepare('UPDATE messages SET text=? WHERE sequence=?')
      .run('B'.repeat(20_000), cursor.sequence)
    expect((await f.remove()).status).toBe(204)
    f.addNextEvidence()
    expect(() => f.generation.prepare(f.workspace.id)).toThrow(ConflictError)
    expect(f.generation.cursor(f.workspace.id)).toEqual(cursor)
  } finally {
    await f.close()
  }
})

test('a failed worker deletion rolls back deletion markers and leaves the original remainder readable', async () => {
  const f = await fixture()
  try {
    f.status('A'.repeat(20_000))
    f.complete(f.claim())
    f.db.exec(
      "CREATE TRIGGER fail_worker_delete BEFORE DELETE ON workers BEGIN SELECT RAISE(ABORT,'worker deletion failure'); END"
    )
    expect((await f.remove()).status).toBe(500)
    expect(
      f.db.prepare('SELECT COUNT(*) AS count FROM memory_dream_deleted_sources').get()
    ).toEqual({ count: 0 })
    f.db.exec('DROP TRIGGER fail_worker_delete')
    const next = f.claim()
    expect(next.generation?.input.messages.map((message) => message.text)).toEqual([
      'A'.repeat(8000),
    ])
    f.complete(next)
    expect(f.store.getAgent(f.workspace.id, f.worker.id).id).toBe(f.worker.id)
  } finally {
    await f.close()
  }
})
