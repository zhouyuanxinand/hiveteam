import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { exportBackupDatabase } from '../../src/server/backup-database.js'
import { dreamSourceVersion, dreamValue } from '../../src/server/memory-dream-snapshots.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createTeamMemoryDreamStore } from '../../src/server/team-memory-dream-store.js'
import { createTeamMemoryStore } from '../../src/server/team-memory-store.js'
import type { MemoryDreamAction, MemoryDreamOperation } from '../../src/shared/memory-dream-plan.js'
import type { TeamMemoryDreamRun } from '../../src/shared/team-memory.js'
import { createAttentionFixture } from '../helpers/attention-fixture.js'
import { startAuthorizedTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const fixtures: Awaited<ReturnType<typeof createAttentionFixture>>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close()
})
const fixture = async () => {
  const f = await createAttentionFixture()
  fixtures.push(f)
  const memory = f.server.store.memory
  const dreams = f.server.store.memoryDream
  const path = `/api/ui/workspaces/${f.workspace.id}/memory/dream`
  const submit = (run: TeamMemoryDreamRun, operations = run.operations) =>
    f.request(`${path}/${run.id}/submit`, {
      orchestrator_id: f.actor,
      expected_revision: run.planRevision,
      operations,
    })
  const rollback = (run: TeamMemoryDreamRun) => f.request(`${path}/${run.id}/rollback`, {})
  const save = (run: TeamMemoryDreamRun, operations: MemoryDreamOperation[]) =>
    fetch(`${f.server.baseUrl}${path}/${run.id}`, {
      method: 'PATCH',
      headers: { cookie: f.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ expected_revision: run.planRevision, operations }),
    })
  const create = (body: string, kind: 'fact' | 'decision' | 'pitfall' = 'fact') =>
    memory.create(f.workspace.id, { kind, body })
  const snapshot = () => f.db.prepare('SELECT * FROM memory_entries ORDER BY id').all()
  return { ...f, memory, dreams, path, submit, rollback, save, create, snapshot }
}
const operation = (
  run: TeamMemoryDreamRun,
  action: MemoryDreamAction,
  ids: string[],
  body = 'Reviewed result'
): MemoryDreamOperation => {
  const sources = ids.map((id) => {
    const snapshot = run.sourceSnapshots.find((source) => source.memory_id === id)
    if (!snapshot) throw new Error('Missing captured source')
    return snapshot
  })
  return {
    id: randomUUID(),
    action,
    sources: sources.map(dreamSourceVersion),
    result:
      action === 'archive'
        ? null
        : {
            ...(sources[0]
              ? dreamValue(sources[0])
              : { kind: 'fact', scope: 'workspace', tags: [], procedure_ref: null }),
            body,
          },
  }
}

test('removing a proposal leaves its source intact and applies the current edited operations atomically', async () => {
  const f = await fixture()
  const keep = f.create('Keep untouched', 'decision')
  const change = f.create('Old fact')
  const run = f.dreams.create(f.workspace.id)
  const selected = [operation(run, 'rewrite', [change.id], 'Unsaved reviewed fact')]
  const response = await f.submit(run, selected)
  expect(response.status).toBe(200)
  const applied = await response.json()
  expect(applied).toMatchObject({
    plan_version: 1,
    plan_revision: 2,
    created_memory_ids: [],
    touched_memory_ids: [change.id],
  })
  expect(applied.change_receipt.changes).toEqual([
    expect.objectContaining({
      memory_id: change.id,
      before: expect.objectContaining({ body: 'Old fact', revision: 1 }),
      after: expect.objectContaining({ body: 'Unsaved reviewed fact', revision: 2 }),
    }),
  ])
  expect(f.memory.get(f.workspace.id, keep.id)).toEqual(keep)
  expect(f.memory.get(f.workspace.id, change.id)?.body).toBe('Unsaved reviewed fact')
})

test('mixed add, rewrite, merge and archive record only exact changes and rollback preserves unrelated edits', async () => {
  const f = await fixture()
  const [rewrite, mergeA, mergeB, archive, untouched] = [
    'rewrite',
    'merge A',
    'merge B',
    'archive',
    'unrelated',
  ].map((body) => f.create(body))
  if (!rewrite || !mergeA || !mergeB || !archive || !untouched)
    throw new Error('Expected fixture sources')
  f.memory.update(f.workspace.id, mergeA.id, { pinned: true })
  const run = f.dreams.create(f.workspace.id)
  const operations = [
    operation(run, 'rewrite', [rewrite.id]),
    operation(run, 'merge', [mergeA.id, mergeB.id]),
    operation(run, 'archive', [archive.id]),
    operation(run, 'add', [untouched.id], 'Additional fact'),
  ]
  const response = await f.submit(run, operations)
  expect(response.status).toBe(200)
  const applied = await response.json()
  expect(applied.created_memory_ids).toHaveLength(2)
  expect(applied.change_receipt.changes).toHaveLength(6)
  expect(applied.change_receipt.actor).toMatchObject({ id: f.actor, role: 'orchestrator' })
  expect(f.memory.get(f.workspace.id, rewrite.id)?.body).toBe('Reviewed result')
  for (const id of [mergeA.id, mergeB.id, archive.id])
    expect(f.memory.get(f.workspace.id, id)?.status).toBe('archived')
  expect(f.memory.get(f.workspace.id, applied.created_memory_ids[0])?.pinned).toBe(true)
  expect(f.memory.sources(f.workspace.id, applied.created_memory_ids[0])).toEqual([
    expect.objectContaining({
      type: 'dream',
      source_id: run.id,
      state: 'current',
      source_sequence: 2,
    }),
  ])
  f.memory.update(f.workspace.id, untouched.id, { body: 'Later unrelated edit' })
  // Injection timestamps do not change the content being rolled back.
  f.db
    .prepare('UPDATE memory_entries SET last_injected_at=? WHERE id=?')
    .run(Date.now(), rewrite.id)
  expect((await f.rollback(run)).status).toBe(200)
  expect(f.memory.get(f.workspace.id, untouched.id)?.body).toBe('Later unrelated edit')
  expect(f.memory.get(f.workspace.id, rewrite.id)).toMatchObject({
    body: 'rewrite',
    status: 'active',
    revision: 3,
  })
  expect(f.memory.get(f.workspace.id, mergeA.id)).toMatchObject({ status: 'active', pinned: true })
  for (const id of applied.created_memory_ids)
    expect(f.memory.get(f.workspace.id, id)).toMatchObject({ status: 'archived', disabled: true })
  const after = f.snapshot()
  expect((await f.rollback(run)).status).toBe(200)
  expect(f.snapshot()).toEqual(after)
  expect((await f.submit(run, operations)).status).toBe(409)
})

test('source revisions, content and scoped identity are validated before any mutation', async () => {
  const f = await fixture()
  const a = f.create('First')
  const b = f.create('Second')
  const run = f.dreams.create(f.workspace.id)
  f.memory.update(f.workspace.id, b.id, { pinned: true })
  const before = f.snapshot()
  const response = await f.submit(run, [
    operation(run, 'rewrite', [a.id]),
    operation(run, 'archive', [b.id]),
  ])
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: expect.stringContaining(b.id) })
  expect(f.snapshot()).toEqual(before)
  expect(f.dreams.get(f.workspace.id, run.id)).toMatchObject({
    status: 'review',
    receipt: null,
    planRevision: 1,
  })
  const forged = operation(run, 'rewrite', [a.id])
  forged.sources[0] = { memory_id: a.id, expected_revision: 999, expected_hash: '0'.repeat(64) }
  expect((await f.submit(run, [forged])).status).toBe(400)
  const other = f.server.store.createWorkspace(join(f.server.dataDir, 'other'), 'Other')
  const foreign = f.memory.create(other.id, { kind: 'fact', body: 'Private other workspace' })
  forged.sources[0] = { memory_id: foreign.id, expected_revision: 1, expected_hash: '0'.repeat(64) }
  expect((await f.submit(run, [forged])).status).toBe(400)
  expect(f.memory.get(other.id, foreign.id)?.body).toBe('Private other workspace')
})

test('a changed report dependency conflicts even when the memory revision has not changed', async () => {
  const f = await fixture()
  const { dispatch } = await f.report('Original evidence')
  const source = f.memory.create(f.workspace.id, {
    kind: 'fact',
    body: 'Captured fact',
    sourceRef: { type: 'dispatch', source_id: dispatch.id },
  })
  f.memory.update(f.workspace.id, source.id, { status: 'active' })
  const run = f.dreams.create(f.workspace.id)
  f.db
    .prepare('UPDATE dispatches SET report_text=?,report_revision=report_revision+1 WHERE id=?')
    .run('New evidence', dispatch.id)
  const before = f.snapshot()
  expect((await f.submit(run)).status).toBe(409)
  expect(f.snapshot()).toEqual(before)
})

test('draft revision conflicts and duplicate source mutations never silently replace a reviewed draft', async () => {
  const f = await fixture()
  const source = f.create('Source')
  const run = f.dreams.create(f.workspace.id)
  const first = [operation(run, 'rewrite', [source.id], 'First reviewer')]
  const saved = await f.save(run, first)
  expect(saved.status).toBe(200)
  expect(await saved.json()).toMatchObject({ plan_revision: 2 })
  expect(
    (await f.save(run, [operation(run, 'rewrite', [source.id], 'Stale reviewer')])).status
  ).toBe(409)
  expect((await f.submit(run, first)).status).toBe(409)
  const current = f.dreams.get(f.workspace.id, run.id)
  if (!current) throw new Error('Expected saved draft')
  expect(
    (await f.submit(current, [...first, operation(current, 'archive', [source.id])])).status
  ).toBe(400)
  expect(f.memory.get(f.workspace.id, source.id)?.body).toBe('Source')
  expect(f.dreams.get(f.workspace.id, run.id)?.operations).toEqual(first)
})

test('identical submit retries return one durable receipt and never reapply later edits', async () => {
  const f = await fixture()
  const source = f.create('Source')
  const run = f.dreams.create(f.workspace.id)
  const operations = [operation(run, 'add', [source.id])]
  const first = await (await f.submit(run, operations)).json()
  f.memory.update(f.workspace.id, first.created_memory_ids[0], { body: 'Later human edit' })
  const before = f.snapshot()
  const duplicate = await f.submit(run, operations)
  expect(duplicate.status).toBe(200)
  expect((await duplicate.json()).change_receipt).toEqual(first.change_receipt)
  expect(f.snapshot()).toEqual(before)
  expect(
    (await f.submit(run, [operation(run, 'add', [source.id], 'Different request')])).status
  ).toBe(409)
  expect((await f.rollback(run)).status).toBe(409)
  expect(f.snapshot()).toEqual(before)
})

test('rollback rejects a changed original memory before restoring any other touched memory', async () => {
  const f = await fixture()
  const a = f.create('First')
  const b = f.create('Second')
  const run = f.dreams.create(f.workspace.id)
  expect(
    (await f.submit(run, [operation(run, 'rewrite', [a.id]), operation(run, 'archive', [b.id])]))
      .status
  ).toBe(200)
  f.memory.update(f.workspace.id, b.id, { body: 'Newer decision', status: 'active' })
  const before = f.snapshot()
  expect((await f.rollback(run)).status).toBe(409)
  expect(f.snapshot()).toEqual(before)
  expect(f.dreams.get(f.workspace.id, run.id)?.status).toBe('submitted')
})

test('a late SQLite failure rolls back memory, revisions, draft changes and receipt together', async () => {
  const f = await fixture()
  const source = f.create('Source')
  const run = f.dreams.create(f.workspace.id)
  const operations = [operation(run, 'archive', [source.id]), operation(run, 'add', [])]
  const before = f.snapshot()
  const revisions = f.db.prepare('SELECT * FROM memory_revisions').all()
  f.db.exec(
    "CREATE TRIGGER fail_dream_receipt BEFORE UPDATE OF change_receipt_json ON memory_dream_runs BEGIN SELECT RAISE(ABORT,'receipt disk failure'); END"
  )
  expect((await f.submit(run, operations)).status).toBe(500)
  expect(f.snapshot()).toEqual(before)
  expect(f.db.prepare('SELECT * FROM memory_revisions').all()).toEqual(revisions)
  expect(f.dreams.get(f.workspace.id, run.id)).toEqual(run)
  f.db.exec('DROP TRIGGER fail_dream_receipt')
  expect((await f.submit(run, operations)).status).toBe(200)
  const applied = f.snapshot()
  f.db.exec(
    "CREATE TRIGGER fail_dream_rollback BEFORE UPDATE OF rolled_back_at ON memory_dream_runs BEGIN SELECT RAISE(ABORT,'rollback disk failure'); END"
  )
  expect((await f.rollback(run)).status).toBe(500)
  expect(f.snapshot()).toEqual(applied)
  expect(f.dreams.get(f.workspace.id, run.id)?.status).toBe('submitted')
  f.db.exec('DROP TRIGGER fail_dream_rollback')
  expect((await f.rollback(run)).status).toBe(200)
})

test('schema 64 drafts and submitted runs remain readable but cannot use unsafe legacy writes', async () => {
  const f = await fixture()
  f.create('Legacy source')
  const draft = f.dreams.create(f.workspace.id)
  const submitted = f.dreams.create(f.workspace.id)
  f.db.prepare("UPDATE memory_dream_runs SET status='submitted' WHERE id=?").run(submitted.id)
  f.db.exec(
    'ALTER TABLE memory_dream_runs DROP COLUMN plan_version; ALTER TABLE memory_dream_runs DROP COLUMN plan_revision; ALTER TABLE memory_dream_runs DROP COLUMN operations_json; ALTER TABLE memory_dream_runs DROP COLUMN change_receipt_json; DELETE FROM schema_version WHERE version=65'
  )
  initializeRuntimeDatabase(f.db)
  initializeRuntimeDatabase(f.db)
  expect(
    f.db.prepare('SELECT COUNT(*) AS count FROM schema_version WHERE version=65').get()
  ).toEqual({ count: 1 })
  const response = await f.request(f.path)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: draft.id, plan_version: 0 }),
      expect.objectContaining({ id: submitted.id, status: 'submitted', change_receipt: null }),
    ])
  )
  expect(f.dreams.listPendingExecution(f.workspace.id)).toEqual([])
  const before = f.snapshot()
  expect((await f.submit(draft)).status).toBe(409)
  expect((await f.save(draft, draft.operations)).status).toBe(409)
  expect((await f.rollback(submitted)).status).toBe(409)
  expect(f.snapshot()).toEqual(before)
  expect(f.dreams.create(f.workspace.id).planVersion).toBe(1)
})

test('backup retains the versioned plan and exact receipt and permits a checked rollback after reopening SQLite', async () => {
  const f = await fixture()
  const a = f.create('A')
  const b = f.create('B')
  const run = f.dreams.create(f.workspace.id)
  expect((await f.submit(run, [operation(run, 'merge', [a.id, b.id])])).status).toBe(200)
  const original = f.dreams.get(f.workspace.id, run.id)
  const path = join(f.server.dataDir, 'dream-backup.sqlite')
  exportBackupDatabase(f.db, path)
  const db = new Database(path)
  try {
    initializeRuntimeDatabase(db)
    const memory = createTeamMemoryStore(db)
    const dreams = createTeamMemoryDreamStore(db, memory)
    expect(dreams.get(f.workspace.id, run.id)).toEqual(original)
    expect(dreams.rollback(f.workspace.id, run.id)?.status).toBe('rolled_back')
    expect(memory.get(f.workspace.id, a.id)).toMatchObject({ body: 'A', status: 'active' })
    expect(f.memory.get(f.workspace.id, a.id)?.status).toBe('archived')
  } finally {
    db.close()
  }
})

test('HTTP retry and rollback survive a complete runtime restart', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-dream-restart-'))
  let server = await startAuthorizedTestServer({ dataDir })
  try {
    const workspace = server.store.createWorkspace(join(dataDir, 'project'), 'Restart')
    const source = server.store.memory.create(workspace.id, {
      kind: 'fact',
      body: 'Before restart',
    })
    const run = server.store.memoryDream.create(workspace.id)
    const operations = [operation(run, 'rewrite', [source.id], 'After apply')]
    let cookie = await getUiCookie(server.baseUrl)
    const request = (suffix: string, body: object) =>
      fetch(
        `${server.baseUrl}/api/ui/workspaces/${workspace.id}/memory/dream/${run.id}/${suffix}`,
        {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      )
    const input = {
      orchestrator_id: `${workspace.id}:orchestrator`,
      expected_revision: 1,
      operations,
    }
    const applied = await (await request('submit', input)).json()
    expect(applied.status).toBe('submitted')
    await server.close()
    server = await startAuthorizedTestServer({ dataDir })
    cookie = await getUiCookie(server.baseUrl)
    expect((await (await request('submit', input)).json()).change_receipt).toEqual(
      applied.change_receipt
    )
    expect((await request('rollback', {})).status).toBe(200)
    expect(server.store.memory.get(workspace.id, source.id)).toMatchObject({
      body: 'Before restart',
      revision: 3,
    })
    expect((await request('rollback', {})).status).toBe(200)
    expect(server.store.memory.get(workspace.id, source.id)?.revision).toBe(3)
  } finally {
    await server.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('draft preparation preserves user scope and complete long bodies instead of truncating a merge', async () => {
  const f = await fixture()
  const a = f.create('A'.repeat(3000))
  const b = f.create('B'.repeat(3000))
  const global = f.memory.create(f.workspace.id, {
    kind: 'fact',
    scope: 'user',
    body: 'Shared preference',
  })
  const run = f.dreams.create(f.workspace.id)
  expect(run.operations).toHaveLength(3)
  expect(run.operations.map((op) => op.action)).toEqual(['rewrite', 'rewrite', 'rewrite'])
  expect(run.operations.find((op) => op.sources[0]?.memory_id === global.id)?.result?.scope).toBe(
    'user'
  )
  expect((await f.submit(run)).status).toBe(200)
  expect(f.memory.get(f.workspace.id, a.id)?.body).toBe('A'.repeat(3000))
  expect(f.memory.get(f.workspace.id, b.id)?.body).toBe('B'.repeat(3000))
  expect(f.memory.get(f.workspace.id, global.id)).toMatchObject({
    scope: 'user',
    workspaceId: null,
    status: 'active',
  })
})
