import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'
import { createRemoteAuditStore } from '../../src/server/remote-audit-store.js'
import { createRemoteDeviceStore } from '../../src/server/remote-device-store.js'
import { stampLoopbackHeaders } from '../../src/server/remote-loopback-auth.js'
import { createRemotePermissionStore } from '../../src/server/remote-permission-store.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []
const roots: string[] = []
afterEach(async () => {
  for (const server of servers.splice(0).reverse()) await server.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const deviceInput = () => ({
  id: randomUUID(),
  name: 'Test phone',
  keys: { d2p: new Uint8Array(32).fill(1), p2d: new Uint8Array(32).fill(2) },
  devicePublicKey: new Uint8Array(32).fill(3),
})
const fixture = async () => {
  const server = await startTestServer()
  servers.push(server)
  const cookie = await getUiCookie(server.baseUrl)
  const workspace = server.store.createWorkspace(join(server.dataDir, 'alpha'), 'Alpha')
  const other = server.store.createWorkspace(join(server.dataDir, 'beta'), 'Beta')
  const device = server.store.remote.devices.insert(deviceInput())
  const remoteHeaders = stampLoopbackHeaders(
    { 'content-type': 'application/json' },
    server.store.getRemoteTunnelSecret(),
    device.id
  )
  const call = (
    path: string,
    body?: unknown,
    method = body === undefined ? 'GET' : 'POST',
    desktop = false
  ) =>
    fetch(`${server.baseUrl}${path}`, {
      method,
      headers: desktop ? { 'content-type': 'application/json', cookie } : remoteHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const scope = (ids: string[]) =>
    call(`/api/remote/devices/${device.id}/scopes`, { workspace_ids: ids }, 'PUT', true)
  const grant = async (actions: string[], duration_ms = 600000) => {
    const response = await call('/api/remote/access-requests', {
      workspace_id: workspace.id,
      actions,
      duration_ms,
    })
    expect(response.status).toBe(201)
    const request = await response.json()
    const approved = await call(
      `/api/remote/access-requests/${request.id}/approve`,
      {},
      'POST',
      true
    )
    expect(approved.status).toBe(200)
    return approved.json()
  }
  return { ...server, workspace, other, device, call, scope, grant, remoteHeaders }
}

describe('remote scopes and temporary authorization across HTTP and SQLite', () => {
  test('new devices have no scope; desktop selection filters workspace and bulk team reads', async () => {
    const ctx = await fixture()
    expect(await (await ctx.call('/api/workspaces')).json()).toEqual([])
    expect(await (await ctx.call('/api/remote/access')).json()).toMatchObject({
      device_id: ctx.device.id,
      workspace_ids: [],
      grants: [],
      mode: 'read_only',
    })
    expect((await ctx.call(`/api/workspaces/${ctx.workspace.id}/tasks`)).status).toBe(403)
    expect(
      (
        await ctx.call(
          `/api/remote/devices/${ctx.device.id}/scopes`,
          { workspace_ids: [ctx.workspace.id] },
          'PUT'
        )
      ).status
    ).toBe(403)
    expect((await ctx.scope([ctx.workspace.id])).status).toBe(200)
    for (const request of [
      { actions: ['task_write'], duration_ms: 600001 },
      { actions: ['not_a_remote_action'], duration_ms: 600000 },
      { actions: [], duration_ms: 600000 },
    ])
      expect(
        (
          await ctx.call('/api/remote/access-requests', {
            workspace_id: ctx.workspace.id,
            ...request,
          })
        ).status
      ).toBe(400)
    const visible = await (await ctx.call('/api/workspaces')).json()
    expect(visible.map((item: { id: string }) => item.id)).toEqual([ctx.workspace.id])
    expect((await ctx.call(`/api/workspaces/${ctx.workspace.id}/tasks`)).status).toBe(200)
    expect((await ctx.call(`/api/workspaces/${ctx.other.id}/tasks`)).status).toBe(403)
    const bulk = await (
      await ctx.call(`/api/ui/team?workspace_ids=${ctx.workspace.id},${ctx.other.id}`)
    ).json()
    expect(Object.keys(bulk.workers_by_workspace_id)).toEqual([ctx.workspace.id])
  })

  test('only desktop approves a bounded request; grants cannot cross actions, workspaces or config boundaries', async () => {
    const ctx = await fixture()
    await ctx.scope([ctx.workspace.id, ctx.other.id])
    const pending = await ctx.call('/api/remote/access-requests', {
      workspace_id: ctx.workspace.id,
      actions: ['task_write'],
      duration_ms: 600000,
      device_id: 'spoofed',
    })
    expect(pending.status).toBe(201)
    const request = await pending.json()
    expect(request.device_id).toBe(ctx.device.id)
    expect((await ctx.call(`/api/remote/access-requests/${request.id}/approve`, {})).status).toBe(
      403
    )
    expect(
      (await ctx.call(`/api/workspaces/${ctx.workspace.id}/tasks`, { content: 'denied' }, 'PUT'))
        .status
    ).toBe(403)
    const approved = await ctx.call(
      `/api/remote/access-requests/${request.id}/approve`,
      {},
      'POST',
      true
    )
    const grant = await approved.json()
    expect(grant).toMatchObject({
      request_id: request.id,
      actions: ['task_write'],
      approved_by: 'local_user',
    })
    const repeated = await (
      await ctx.call(`/api/remote/access-requests/${request.id}/approve`, {}, 'POST', true)
    ).json()
    expect(repeated.id).toBe(grant.id)
    expect(repeated.expires_at).toBe(grant.expires_at)
    const secret = `synthetic-input-secret-${randomUUID()}`
    const tasks = await (await ctx.call(`/api/workspaces/${ctx.workspace.id}/tasks`)).json()
    expect(
      (
        await ctx.call(
          `/api/workspaces/${ctx.workspace.id}/tasks`,
          { content: secret, expected_version: tasks.version },
          'PUT'
        )
      ).status
    ).toBe(200)
    expect(readFileSync(join(ctx.dataDir, 'alpha', '.hive', 'tasks.md'), 'utf8')).toBe(secret)
    expect(
      (await ctx.call(`/api/workspaces/${ctx.other.id}/tasks`, { content: secret }, 'PUT')).status
    ).toBe(403)
    for (const [method, path] of [
      ['GET', '/api/settings/app-state/remote_daemon_token'],
      ['PUT', '/api/remote/config'],
      ['POST', '/api/settings/command-presets'],
      ['PATCH', `/api/workspaces/${ctx.workspace.id}/recovery-settings`],
      ['DELETE', `/api/workspaces/${ctx.workspace.id}`],
      ['GET', '/api/external-goals/session'],
    ] as const)
      expect((await ctx.call(path, method === 'GET' ? undefined : {}, method)).status).toBe(403)
    expect(
      (await ctx.call(`/api/workspaces/${ctx.workspace.id}/tasks`, {}, 'PUT')).status
    ).toBeGreaterThanOrEqual(400)
    const audit = ctx.store.remote.audit.list(1000)
    expect(JSON.stringify(audit)).not.toContain(secret)
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'http',
          method: 'PUT',
          business_action: 'task_write',
          status_code: 200,
          result: 'ok',
          grant_id: grant.id,
        }),
        expect.objectContaining({ action: 'http', status_code: 403, result: 'rejected' }),
        expect.objectContaining({ action: 'http', business_action: 'task_write', result: 'error' }),
      ])
    )
    expect((await ctx.call(`/api/remote/grants/${grant.id}/revoke`, {}, 'POST', true)).status).toBe(
      204
    )
    expect(
      (
        await ctx.call(
          `/api/workspaces/${ctx.workspace.id}/tasks`,
          { content: 'after revoke' },
          'PUT'
        )
      ).status
    ).toBe(403)
  })

  test('scope removal revokes old grants and re-adding the scope does not restore them', async () => {
    const ctx = await fixture()
    await ctx.scope([ctx.workspace.id])
    await ctx.grant(['task_write'])
    await ctx.scope([])
    await ctx.scope([ctx.workspace.id])
    expect(ctx.store.remote.permissions.getAccess(ctx.device.id).grants).toEqual([])
    expect(
      (await ctx.call(`/api/workspaces/${ctx.workspace.id}/tasks`, { content: 'forbidden' }, 'PUT'))
        .status
    ).toBe(403)
  })

  test('a body arriving after its bound grant expires cannot write a task file', async () => {
    const ctx = await fixture()
    await ctx.scope([ctx.workspace.id])
    await ctx.grant(['task_write'], 1000)
    const before = await (await ctx.call(`/api/workspaces/${ctx.workspace.id}/tasks`)).json()
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(
        `${ctx.baseUrl}/api/workspaces/${ctx.workspace.id}/tasks`,
        { method: 'PUT', headers: ctx.remoteHeaders },
        (response) => {
          let body = ''
          response.on('data', (chunk) => {
            body += chunk
          })
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
        }
      )
      request.on('error', reject)
      request.write(`{"expected_version":${JSON.stringify(before.version)},"content":`)
      setTimeout(() => request.end('"too late"}'), 1100)
    })
    expect(result.status).toBe(403)
    expect(JSON.parse(result.body)).toMatchObject({ code: 'remote_grant_expired' })
    expect(await (await ctx.call(`/api/workspaces/${ctx.workspace.id}/tasks`)).json()).toEqual(
      before
    )
  })
})

describe('remote grant persistence and failure boundaries', () => {
  test('monotonic expiry, restart, and audit failure never increase effective permission', () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-remote-grants-'))
    roots.push(root)
    const path = join(root, 'state.sqlite')
    let db = new Database(path)
    initializeRuntimeDatabase(db)
    const device = createRemoteDeviceStore(db).insert(deviceInput())
    const workspaceId = randomUUID()
    db.prepare('INSERT INTO workspaces(id, name, path, created_at) VALUES (?, ?, ?, ?)').run(
      workspaceId,
      'Scope',
      root,
      1
    )
    let wall = 10000
    let monotonic = 0
    let store = createRemotePermissionStore(db, createRemoteAuditStore(db), {
      now: () => wall,
      monotonic: () => monotonic,
    })
    store.setReadScopes(device.id, [workspaceId])
    const request = store.request(device.id, {
      workspaceId,
      actions: ['terminal_input'],
      durationMs: 1000,
    })
    const grant = store.approve(request.id)
    expect(store.authorize(device.id, workspaceId, 'terminal_input')).toBe(grant.id)
    wall = 5000
    monotonic = 1000
    expect(() => store.authorize(device.id, workspaceId, 'terminal_input')).toThrow(
      'Desktop approval'
    )
    const next = store.request(device.id, { workspaceId, actions: ['terminal_input'] })
    const active = store.approve(next.id)
    const pending = store.request(device.id, { workspaceId, actions: ['agent_stop'] })
    db.exec(
      "CREATE TRIGGER reject_audit BEFORE INSERT ON remote_audit BEGIN SELECT RAISE(ABORT, 'synthetic audit unavailable'); END"
    )
    expect(() => store.approve(pending.id)).toThrow('synthetic audit unavailable')
    expect(store.authorize(device.id, workspaceId, 'terminal_input')).toBe(active.id)
    expect(store.listRequests(device.id).find((item) => item.id === pending.id)?.status).toBe(
      'pending'
    )
    expect(
      db.prepare('SELECT id FROM remote_write_grants WHERE request_id = ?').get(pending.id)
    ).toBeUndefined()
    db.exec('DROP TRIGGER reject_audit')
    wall = active.expires_at + 1
    expect(() => store.authorize(device.id, workspaceId, 'terminal_input')).toThrow(
      'Desktop approval'
    )
    wall = 5000
    expect(() => store.authorize(device.id, workspaceId, 'terminal_input')).toThrow(
      'Desktop approval'
    )
    store.close()
    db.close()
    db = new Database(path)
    initializeRuntimeDatabase(db)
    store = createRemotePermissionStore(db, createRemoteAuditStore(db))
    expect(store.getAccess(device.id)).toMatchObject({
      workspace_ids: [workspaceId],
      grants: [],
      mode: 'read_only',
    })
    expect(() => store.approve(pending.id)).toThrow('no longer pending')
    expect(db.prepare('SELECT id FROM remote_write_grants WHERE id = ?').get(active.id)).toEqual({
      id: active.id,
    })
    store.close()
    db.close()
  })
})
