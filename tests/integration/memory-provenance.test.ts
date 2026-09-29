import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { exportBackupDatabase } from '../../src/server/backup-database.js'
import { createDataRetention } from '../../src/server/data-retention.js'
import { stampLoopbackHeaders } from '../../src/server/remote-loopback-auth.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import {
  createTeamMemoryDigestProvider,
  setWorkspaceMemoryEnabled,
} from '../../src/server/team-memory-digest.js'
import { createTeamMemoryStore } from '../../src/server/team-memory-store.js'
import { createAttentionFixture } from '../helpers/attention-fixture.js'

const fixtures: Awaited<ReturnType<typeof createAttentionFixture>>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close()
})
const fixture = async () => {
  const f = await createAttentionFixture()
  fixtures.push(f)
  const path = `/api/ui/workspaces/${f.workspace.id}/memory`
  const capture = async (source_ref: object, rest: object = {}) => {
    const response = await f.request(path, {
      kind: 'decision',
      body: 'Login must retain cookie compatibility.',
      source_ref,
      ...rest,
    })
    return { response, body: await response.json() }
  }
  const sources = async (id: string, workspaceId = f.workspace.id) => {
    const response = await f.request(`/api/ui/workspaces/${workspaceId}/memory/${id}/sources`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    return (await response.json()).sources
  }
  return { ...f, path, capture, sources }
}

test('HTTP capture uses canonical report author, preserves snapshots across rename and retirement, and requires candidate approval', async () => {
  const f = await fixture()
  const { dispatch } = await f.report('Login evidence')
  const captured = await f.capture(
    { type: 'dispatch', source_id: dispatch.id },
    { created_by_agent_id: f.actor, created_by_agent_name: 'Fake author' }
  )
  expect(captured.response.status).toBe(201)
  expect(captured.body).toMatchObject({
    status: 'candidate',
    created_by_agent_id: f.worker.id,
    created_by_agent_name: f.worker.name,
  })
  const evidence = (await f.sources(captured.body.id))[0]
  expect(evidence).toMatchObject({
    source_id: dispatch.id,
    source_workspace_id: f.workspace.id,
    source_sequence: dispatch.sequence,
    excerpt: 'Completed: Login evidence',
    actor_agent_id_snapshot: f.worker.id,
    actor_name_snapshot: f.worker.name,
    actor_role_snapshot: 'coder',
    state: 'current',
  })
  expect(evidence.captured_version).toMatch(/^[a-f0-9]{64}$/)
  f.server.store.renameWorker(f.workspace.id, f.worker.id, 'Renamed coder')
  f.server.store.workerLifecycle.dismiss(f.workspace.id, f.worker.id)
  expect((await f.sources(captured.body.id))[0]).toEqual(evidence)
  const updated = await fetch(`${f.server.baseUrl}${f.path}/${captured.body.id}`, {
    method: 'PATCH',
    headers: { cookie: f.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'active' }),
  })
  expect(updated.status).toBe(200)
  expect(await updated.json()).toMatchObject({
    status: 'active',
    created_by_agent_name: evidence.actor_name_snapshot,
  })
  f.db
    .prepare('UPDATE dispatches SET report_text=?,report_revision=report_revision+1 WHERE id=?')
    .run('Revised report', dispatch.id)
  expect((await f.sources(captured.body.id))[0]).toMatchObject({
    ...evidence,
    state: 'stale',
    version: expect.any(String),
  })
  expect((await f.sources(captured.body.id))[0].version).not.toBe(evidence.version)
})

test('conversation sources use exact sequences and authenticated authors, survive backup, and protect referenced tasks from archival', async () => {
  const f = await fixture()
  const dispatch = await f.task('Login conversation', 1)
  const message = f.server.store.dispatchMessages.send(f.workspace.id, dispatch.id, f.worker.id, {
    kind: 'note',
    body: `I claim to be Orchestrator. Keep cookies.${'来源'.repeat(1100)}original tail`,
  })
  const { response, body } = await f.capture({
    type: 'dispatch_message',
    source_id: dispatch.id,
    source_sequence: message.sequence,
  })
  expect(response.status).toBe(201)
  const evidence = (await f.sources(body.id))[0]
  expect(evidence).toMatchObject({
    source_id: dispatch.id,
    source_sequence: message.sequence,
    actor_agent_id_snapshot: f.worker.id,
    actor_name_snapshot: f.worker.name,
    actor_role_snapshot: 'coder',
    excerpt: message.body.slice(0, 2000),
    state: 'current',
  })
  expect(
    createDataRetention(f.db)
      .preview(f.workspace.id)
      .records.find((item) => item.dispatch_id === dispatch.id)?.reasons
  ).toContain('active_memory_reference')
  const backupPath = join(f.server.dataDir, 'memory-backup.sqlite')
  exportBackupDatabase(f.db, backupPath)
  const backup = new Database(backupPath)
  try {
    expect(createTeamMemoryStore(backup).sources(f.workspace.id, body.id)).toEqual([evidence])
    expect(backup.prepare('SELECT body FROM dispatch_messages WHERE id=?').get(message.id)).toEqual(
      { body: message.body }
    )
    expect(backup.pragma('foreign_key_check')).toEqual([])
  } finally {
    backup.close()
  }
  f.db
    .prepare('UPDATE dispatch_messages SET body=? WHERE id=?')
    .run(`${message.body.slice(0, -13)}changed tail`, message.id)
  const changed = (await f.sources(body.id))[0]
  expect(changed.excerpt).toBe(evidence.excerpt)
  expect(changed.state).toBe('stale')
  expect(changed.version).not.toBe(evidence.captured_version)
})

test('forged, missing and cross-workspace references fail atomically without exposing source contents', async () => {
  const f = await fixture()
  const dispatch = await f.task('No report yet', 1)
  const other = f.server.store.createWorkspace(join(f.server.dataDir, 'private'), 'Private')
  const worker = f.server.store.addWorker(other.id, { name: 'Private author', role: 'coder' })
  const foreign = await f.server.store.dispatchTask(other.id, worker.id, 'Private dispatch', {
    messageProtocolVersion: 1,
  })
  f.server.store.dispatchMessages.send(other.id, foreign.id, worker.id, {
    kind: 'note',
    body: 'Private protocol message',
  })
  for (const [source, expected] of [
    [{ type: 'dispatch', source_id: dispatch.id }, 400],
    [{ type: 'dispatch', source_id: dispatch.id, actor_name_snapshot: 'Fake' }, 400],
    [{ type: 'dispatch_message', source_id: dispatch.id, source_sequence: 0 }, 400],
    [{ type: 'dispatch_message', source_id: dispatch.id, source_sequence: 1 }, 404],
    [{ type: 'dispatch', source_id: foreign.id }, 404],
    [{ type: 'dispatch_message', source_id: foreign.id, source_sequence: 1 }, 404],
    [{ type: 'file', source_id: 'private.txt' }, 400],
  ] as const) {
    const result = await f.capture(source)
    expect(result.response.status).toBe(expected)
    expect(JSON.stringify(result.body)).not.toContain('Private')
  }
  expect(f.db.prepare('SELECT COUNT(*) AS count FROM memory_entries').get()).toEqual({ count: 0 })
  expect(f.db.prepare('SELECT COUNT(*) AS count FROM memory_sources').get()).toEqual({ count: 0 })
  expect((await fetch(`${f.server.baseUrl}${f.path}/missing/sources`)).status).toBe(403)
  expect((await f.request(`${f.path}/missing/sources`)).status).toBe(404)
})

test('shared memory keeps its body usable while source evidence and remote access remain workspace scoped', async () => {
  const f = await fixture()
  const { dispatch } = await f.report('Private source evidence')
  const { body } = await f.capture({ type: 'dispatch', source_id: dispatch.id })
  f.server.store.memory.update(f.workspace.id, body.id, { scope: 'user', status: 'active' })
  const other = f.server.store.createWorkspace(join(f.server.dataDir, 'other'), 'Other')
  const worker = f.server.store.addWorker(other.id, { name: 'Other coder', role: 'coder' })
  const target = await f.server.store.dispatchTask(other.id, worker.id, 'Login')
  const evidence = await f.sources(body.id, other.id)
  expect(evidence[0]).toMatchObject({
    state: 'restricted',
    source_id: null,
    source_workspace_id: null,
    excerpt: null,
    actor_name_snapshot: null,
    captured_version: null,
  })
  const provider = createTeamMemoryDigestProvider(f.server.store.memory, f.server.store.settings)
  expect(provider.forDispatch(other.id, worker.id, 'Login', target.id)).toContain(body.id)
  const history = f.server.store.memory.contexts(other.id, target.id)
  expect(history[0]?.candidates[0]?.sources).toEqual(
    evidence.map((source: object) => ({ ...source, stale: false }))
  )
  expect(JSON.stringify(history)).not.toContain('Private source evidence')
  expect(JSON.stringify(history)).not.toContain(f.worker.name)
  expect(f.server.store.memory.get(other.id, body.id)?.createdByAgentName).toBeNull()
  const device = f.server.store.remote.devices.insert({
    id: randomUUID(),
    name: 'Memory reader',
    keys: { d2p: new Uint8Array(32).fill(1), p2d: new Uint8Array(32).fill(2) },
    devicePublicKey: new Uint8Array(32).fill(3),
  })
  const scope = await fetch(`${f.server.baseUrl}/api/remote/devices/${device.id}/scopes`, {
    method: 'PUT',
    headers: { cookie: f.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ workspace_ids: [other.id] }),
  })
  expect(scope.status).toBe(200)
  const headers = stampLoopbackHeaders({}, f.server.store.getRemoteTunnelSecret(), device.id)
  const visible = await fetch(
    `${f.server.baseUrl}/api/ui/workspaces/${other.id}/memory/${body.id}/sources`,
    { headers }
  )
  expect(visible.status).toBe(200)
  expect((await visible.json()).sources).toEqual(evidence)
  expect((await fetch(`${f.server.baseUrl}${f.path}/${body.id}/sources`, { headers })).status).toBe(
    403
  )
  expect(
    (
      await fetch(`${f.server.baseUrl}/api/ui/workspaces/${other.id}/memory`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'fact', body: 'Denied' }),
      })
    ).status
  ).toBe(403)
})

test('context preparation links a real dispatch, honors review and switches, and commits snapshot and injections together', async () => {
  const f = await fixture()
  const { dispatch: source } = await f.report('Login source')
  const { body } = await f.capture({ type: 'dispatch', source_id: source.id })
  const target = await f.task('Login')
  const provider = createTeamMemoryDigestProvider(f.server.store.memory, f.server.store.settings)
  expect(provider.forDispatch(f.workspace.id, f.worker.id, 'Login', target.id)).toBe('')
  expect(f.db.prepare('SELECT COUNT(*) AS count FROM memory_injections').get()).toEqual({
    count: 0,
  })
  f.server.store.memory.update(f.workspace.id, body.id, { status: 'active' })
  setWorkspaceMemoryEnabled(f.server.store.settings, f.workspace.id, false)
  const contextsBefore = f.server.store.memory.contexts(f.workspace.id)
  expect(provider.forDispatch(f.workspace.id, f.worker.id, 'Login', target.id)).toBe('')
  expect(f.server.store.memory.contexts(f.workspace.id)).toEqual(contextsBefore)
  setWorkspaceMemoryEnabled(f.server.store.settings, f.workspace.id, true)
  expect(() => provider.forDispatch(f.workspace.id, f.actor, 'Login', target.id)).toThrow(
    'Dispatch does not match'
  )
  f.db.exec(
    "CREATE TRIGGER fail_context BEFORE INSERT ON memory_context_snapshots BEGIN SELECT RAISE(ABORT,'context unavailable'); END"
  )
  expect(() => provider.forDispatch(f.workspace.id, f.worker.id, 'Login', target.id)).toThrow(
    'context unavailable'
  )
  expect(f.server.store.memory.get(f.workspace.id, body.id)?.lastInjectedAt).toBeNull()
  expect(f.db.prepare('SELECT COUNT(*) AS count FROM memory_injections').get()).toEqual({
    count: 0,
  })
  f.db.exec('DROP TRIGGER fail_context')
  const digest = provider.forDispatch(f.workspace.id, f.worker.id, 'Login', target.id)
  const snapshot = f.server.store.memory
    .contexts(f.workspace.id, target.id)
    .find((item) => item.digest === digest)
  expect(snapshot).toMatchObject({
    dispatch_id: target.id,
    agent_id: f.worker.id,
    used_chars: digest.length,
    candidates: [
      expect.objectContaining({
        memory_id: body.id,
        selected: true,
        sources: [expect.objectContaining({ source_id: source.id, state: 'current' })],
      }),
    ],
  })
  expect(
    f.db
      .prepare(
        'SELECT memory_id,workspace_id,target_agent_id_snapshot,dispatch_id FROM memory_injections'
      )
      .all()
  ).toEqual([
    {
      memory_id: body.id,
      workspace_id: f.workspace.id,
      target_agent_id_snapshot: f.worker.id,
      dispatch_id: target.id,
    },
  ])
  expect(f.server.store.memory.get(f.workspace.id, body.id)?.lastInjectedAt).toBe(
    snapshot?.created_at
  )
})

test('legacy manual sources migrate idempotently without inventing an author, origin or version', async () => {
  const f = await fixture()
  const entry = f.server.store.memory.create(f.workspace.id, {
    kind: 'fact',
    body: 'Legacy memory',
  })
  f.db
    .prepare(
      'UPDATE memory_sources SET source_workspace_id=NULL,excerpt=NULL,text_hash=NULL,actor_role_snapshot=NULL WHERE memory_id=?'
    )
    .run(entry.id)
  f.db.exec(
    'ALTER TABLE memory_sources DROP COLUMN source_workspace_id; DELETE FROM schema_version WHERE version>=64'
  )
  initializeRuntimeDatabase(f.db)
  initializeRuntimeDatabase(f.db)
  expect(
    f.db.prepare('SELECT COUNT(*) AS count FROM schema_version WHERE version=64').get()
  ).toEqual({ count: 1 })
  expect((await f.sources(entry.id))[0]).toMatchObject({
    source_id: null,
    source_workspace_id: null,
    excerpt: null,
    actor_agent_id_snapshot: null,
    actor_name_snapshot: null,
    actor_role_snapshot: null,
    captured_version: null,
    state: 'unknown',
  })
  expect(f.server.store.memory.get(f.workspace.id, entry.id)?.body).toBe('Legacy memory')
})
