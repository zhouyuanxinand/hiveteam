import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, test } from 'vitest'
import { createAgentSessionStore } from '../../src/server/agent-session-store.js'
import { stampLoopbackHeaders } from '../../src/server/remote-loopback-auth.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import type { NativeSessionContext } from '../../src/shared/native-session.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Awaited<ReturnType<typeof startTestServer>>[] = []
const databases: Database.Database[] = []
afterEach(async () => {
  for (const db of databases.splice(0)) db.close()
  for (const server of servers.splice(0)) await server.close()
})
const setup = async () => {
  const server = await startTestServer()
  servers.push(server)
  const workspace = server.store.createWorkspace(server.dataDir, 'Native state fixture')
  const worker = server.store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
  const db = new Database(join(server.dataDir, 'runtime.sqlite'))
  databases.push(db)
  const sessions = createAgentSessionStore(db)
  const context: NativeSessionContext = {
    cwd: server.dataDir,
    storage_root: join(server.dataDir, 'native'),
    platform: process.platform,
    policy_revision: 'fixture-policy',
    cli_fingerprint: 'fixture-binary',
    adapter_revision: 'fixture-v1',
  }
  const reservation = () =>
    server.store.resources.reserve({
      workspaceId: workspace.id,
      agentId: worker.id,
      executionKey: `agent:${worker.id}`,
      kind: 'worker',
    })
  return { server, workspace, worker, db, sessions, context, reservation }
}

test('an interrupted allocation is reconciled only after the resource owner proves it released the slot', async () => {
  const f = await setup(),
    reservation = f.reservation()
  const started = f.sessions.native.begin({
    workspaceId: f.workspace.id,
    agentId: f.worker.id,
    harness: 'cursor',
    context: f.context,
    reservationId: reservation.id,
  })
  f.sessions.native.allocating(started.attempt.id)
  const reopened = createAgentSessionStore(f.db)
  expect(() =>
    reopened.native.newGeneration(
      f.workspace.id,
      f.worker.id,
      started.generation.id,
      'Cannot replace an unconfirmed writer'
    )
  ).toThrow(/execution/u)
  f.server.store.resources.release(reservation.id, { reason: 'spawn_not_started' })
  reopened.native.reconcile()
  expect(reopened.native.current(f.workspace.id, f.worker.id)).toMatchObject({
    id: started.generation.id,
    state: 'uncertain',
    native_id: null,
    last_error: { code: 'session_allocation_uncertain' },
  })
  expect(reopened.native.attempt(started.attempt.id).state).toBe('uncertain')
  const next = f.reservation()
  expect(() =>
    reopened.native.begin({
      workspaceId: f.workspace.id,
      agentId: f.worker.id,
      harness: 'cursor',
      context: f.context,
      reservationId: next.id,
    })
  ).toThrow(/unknown/u)
  f.server.store.resources.release(next.id, { reason: 'spawn_not_started' })
})

test('native ID ownership and failed context persistence keep both the durable binding and legacy pointer', async () => {
  const f = await setup(),
    reservation = f.reservation()
  const first = f.sessions.native.begin({
    workspaceId: f.workspace.id,
    agentId: f.worker.id,
    harness: 'grok',
    context: f.context,
    reservationId: reservation.id,
  })
  f.sessions.native.allocating(first.attempt.id)
  const id = randomUUID()
  f.sessions.native.bind(first.attempt.id, id)
  f.server.store.resources.release(reservation.id, { reason: 'spawn_not_started' })
  f.sessions.native.reconcile()
  expect(f.sessions.getLastSessionId(f.workspace.id, f.worker.id)).toBe(id)
  f.db.exec(
    "CREATE TRIGGER deny_session_rebind BEFORE UPDATE OF context_json ON native_session_generations BEGIN SELECT RAISE(ABORT,'synthetic context failure'); END"
  )
  expect(() =>
    f.sessions.native.rebind(
      f.workspace.id,
      f.worker.id,
      first.generation.id,
      { ...f.context, cwd: join(f.context.cwd, 'moved') },
      'Moved workspace'
    )
  ).toThrow(/synthetic context failure/u)
  expect(f.sessions.native.current(f.workspace.id, f.worker.id)?.context).toEqual(f.context)
  expect(f.db.prepare('SELECT * FROM native_session_context_events').all()).toEqual([])
  f.db.exec('DROP TRIGGER deny_session_rebind')
  const bob = f.server.store.addWorker(f.workspace.id, { name: 'Bob', role: 'coder' })
  const other = f.server.store.resources.reserve({
    workspaceId: f.workspace.id,
    agentId: bob.id,
    executionKey: `agent:${bob.id}`,
    kind: 'worker',
  })
  const second = f.sessions.native.begin({
    workspaceId: f.workspace.id,
    agentId: bob.id,
    harness: 'grok',
    context: f.context,
    reservationId: other.id,
  })
  f.sessions.native.allocating(second.attempt.id)
  expect(() => f.sessions.native.bind(second.attempt.id, id)).toThrow(/already bound/u)
  expect(f.sessions.getLastSessionId(f.workspace.id, f.worker.id)).toBe(id)
  expect(f.sessions.native.current(f.workspace.id, bob.id)?.native_id).toBeNull()
  f.server.store.resources.release(other.id, { reason: 'spawn_not_started' })
})

test('new presets migrate once without rewriting same-ID user configuration or old session capture', async () => {
  const f = await setup()
  f.db
    .prepare(
      "UPDATE command_presets SET command='my-cursor-wrapper',args='[\"custom\"]',is_builtin=0 WHERE id='cursor'"
    )
    .run()
  f.db.prepare("DELETE FROM command_presets WHERE id='grok'").run()
  f.db.prepare('DELETE FROM schema_version WHERE version=57').run()
  f.sessions.setLastSessionId(f.workspace.id, f.worker.id, 'old-claude-session')
  initializeRuntimeDatabase(f.db)
  expect(
    f.db.prepare("SELECT command,args,is_builtin FROM command_presets WHERE id='cursor'").get()
  ).toEqual({ command: 'my-cursor-wrapper', args: '["custom"]', is_builtin: 0 })
  expect(
    f.db
      .prepare(
        "SELECT command,yolo_args_template,session_id_capture FROM command_presets WHERE id='grok'"
      )
      .get()
  ).toEqual({ command: 'grok', yolo_args_template: '[]', session_id_capture: null })
  expect(createAgentSessionStore(f.db).getLastSessionId(f.workspace.id, f.worker.id)).toBe(
    'old-claude-session'
  )
  expect(f.db.prepare('SELECT * FROM native_session_generations').all()).toEqual([])
  initializeRuntimeDatabase(f.db)
  expect(
    f.db.prepare('SELECT COUNT(*) AS count FROM schema_version WHERE version=57').get()
  ).toEqual({ count: 1 })
})

test('native session metadata and mutations require local desktop identity and cannot cross workspace ownership', async () => {
  const f = await setup()
  const device = f.server.store.remote.devices.insert({
    id: randomUUID(),
    name: 'Fixture phone',
    keys: { d2p: new Uint8Array(32).fill(1), p2d: new Uint8Array(32).fill(2) },
    devicePublicKey: new Uint8Array(32).fill(3),
  })
  const path = `/api/ui/workspaces/${f.workspace.id}/agents/${f.worker.id}/native-session`
  for (const headers of [
    {},
    { 'x-hive-agent-id': f.worker.id, 'x-hive-agent-token': 'fixture' },
    stampLoopbackHeaders({}, f.server.store.getRemoteTunnelSecret(), device.id),
  ]) {
    for (const method of ['GET', 'POST']) {
      const response = await fetch(f.server.baseUrl + path, {
        method,
        headers: { ...headers, 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      })
      expect([401, 403]).toContain(response.status)
    }
  }
  const other = f.server.store.createWorkspace(join(f.server.dataDir, 'other'), 'Other')
  const cookie = await getUiCookie(f.server.baseUrl)
  const wrong = await fetch(
    `${f.server.baseUrl}/api/ui/workspaces/${other.id}/agents/${f.worker.id}/native-session`,
    { headers: { cookie } }
  )
  expect(wrong.status).toBe(404)
  const valid = await fetch(f.server.baseUrl + path, { headers: { cookie } })
  expect(valid.headers.get('cache-control')).toBe('no-store')
  expect((await valid.json()).harness).toBeNull()
  expect(f.db.prepare('SELECT * FROM native_session_generations').all()).toEqual([])
})
