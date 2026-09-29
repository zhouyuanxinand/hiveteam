import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { stampLoopbackHeaders } from '../../src/server/remote-loopback-auth.js'
import Database from '../../src/server/sqlite.js'
import { startAuthorizedTestServer, startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

test('resource management requires local identity and validates and audits persistent limits', async () => {
  const server = await startTestServer()
  try {
    const cookie = await getUiCookie(server.baseUrl)
    const device = server.store.remote.devices.insert({
      id: randomUUID(),
      name: 'Read-only phone',
      keys: { d2p: new Uint8Array(32).fill(1), p2d: new Uint8Array(32).fill(2) },
      devicePublicKey: new Uint8Array(32).fill(3),
    })
    const remote = stampLoopbackHeaders({}, server.store.getRemoteTunnelSecret(), device.id)
    for (const headers of [
      {},
      remote,
      { 'x-hive-agent-id': 'agent', 'x-hive-agent-token': 'token' },
    ]) {
      for (const [method, path] of [
        ['GET', '/api/resources'],
        ['PUT', '/api/resources'],
        ['POST', '/api/resources/reconcile'],
        ['POST', '/api/resources/queue/example/cancel'],
      ] as const) {
        const response = await fetch(server.baseUrl + path, { method, headers })
        expect(response.status).toBe(403)
        expect(await response.text()).not.toContain('max_running_total')
      }
    }
    const initial = server.store.resources.getLimits()
    const put = (body: unknown) =>
      fetch(`${server.baseUrl}/api/resources`, {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    for (const body of [
      null,
      [],
      {},
      { max_running_total: 0 },
      { max_running_total: 1001 },
      { max_running_total: 1.5 },
      { max_running_total: '2' },
      { unsupported_limit: 3 },
    ]) {
      expect((await put(body)).status).toBe(400)
      expect(server.store.resources.getLimits()).toEqual(initial)
    }
    const updated = await put({ max_running_total: 2, max_workers_per_workspace: 1 })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({
      limits: { ...initial, max_running_total: 2, max_workers_per_workspace: 1 },
      occupancy: { global: 0 },
      reservations: [],
      queue: [],
    })
    const db = new Database(join(server.dataDir, 'runtime.sqlite'), { readonly: true })
    try {
      const audit = db
        .prepare('SELECT actor, before_json, after_json FROM resource_limit_audit')
        .all() as Array<{ actor: string; before_json: string; after_json: string }>
      expect(audit).toHaveLength(1)
      expect(audit[0]?.actor).toBe('local_user')
      expect(JSON.parse(audit[0]?.before_json ?? '')).toEqual(initial)
      expect(JSON.parse(audit[0]?.after_json ?? '')).toMatchObject({
        max_running_total: 2,
        max_workers_per_workspace: 1,
      })
    } finally {
      db.close()
    }
    const workspace = server.store.createWorkspace(server.dataDir, 'Membership limit')
    server.store.addWorker(workspace.id, { name: 'Existing member', role: 'reviewer' })
    const rejected = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/workers`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Extra', role: 'reviewer' }),
    })
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({
      code: 'resource_limit_reached',
      reason: 'worker_limit',
    })
    expect(server.store.listWorkers(workspace.id)).toHaveLength(1)
  } finally {
    await server.close()
  }
})

test('HTTP start rejects a full budget and makes capacity available only after the PTY exits', async () => {
  const server = await startAuthorizedTestServer()
  try {
    const workspace = server.store.createWorkspace(server.dataDir, 'PTY budget')
    const worker = server.store.addWorker(workspace.id, { name: 'Holder', role: 'reviewer' })
    server.store.configureAgentLaunch(workspace.id, worker.id, {
      command: process.execPath,
      args: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'],
    })
    server.store.resources.updateLimits({ max_running_total: 1 }, { actor: 'local_user' })
    const run = await server.store.startAgent(workspace.id, worker.id, {
      hivePort: new URL(server.baseUrl).port,
    })
    const cookie = await getUiCookie(server.baseUrl)
    const shell = () =>
      fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/shell/start`, {
        method: 'POST',
        headers: { cookie },
      })
    const denied = await shell()
    expect(denied.status).toBe(409)
    expect(await denied.json()).toMatchObject({
      code: 'resource_limit_reached',
      reason: 'global_limit',
      resources: { occupancy: { global: 1 } },
    })
    const token = server.store.peekAgentToken(worker.id)
    expect(token).toBeTruthy()
    const agentRead = await fetch(`${server.baseUrl}/api/resources`, {
      headers: { 'x-hive-agent-id': worker.id, 'x-hive-agent-token': token ?? '' },
    })
    expect(agentRead.status).toBe(403)
    const stop = await fetch(`${server.baseUrl}/api/runtime/runs/${run.runId}/stop`, {
      method: 'POST',
      headers: { cookie },
    })
    expect(stop.status).toBe(202)
    await expect
      .poll(() => server.store.resources.getSnapshot().occupancy.global, { timeout: 6000 })
      .toBe(0)
    const started = await shell()
    expect(started.status).toBe(201)
    const status = await (
      await fetch(`${server.baseUrl}/api/resources`, { headers: { cookie } })
    ).json()
    expect(status.occupancy).toMatchObject({
      global: 1,
      by_kind: { worker: 0, workspace_shell: 1 },
    })
    expect(status.occupants).toEqual([expect.objectContaining({ can_stop: true })])
    expect(server.store.listWorkers(workspace.id)).toHaveLength(1)
  } finally {
    await server.close()
  }
}, 30_000)
