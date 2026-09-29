import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import WebSocket from 'ws'
import { createAgentManager } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import { stampLoopbackHeaders } from '../../src/server/remote-loopback-auth.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import Database from '../../src/server/sqlite.js'
import type { RemoteAction } from '../../src/shared/remote-permissions.js'
import { authorizeSyntheticAgent } from '../helpers/authorized-runtime.js'
import { listenOnFetchSafePort } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const waitFor = async (assertion: () => void) => {
  let failure: unknown
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try {
      assertion()
      return
    } catch (error) {
      failure = error
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw failure
}
const fixture = async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-remote-terminal-'))
  const manager = createAgentManager()
  const store = createRuntimeStore({ dataDir, agentManager: manager })
  const app = createApp({ store })
  const port = await listenOnFetchSafePort(app.server)
  const baseUrl = `http://127.0.0.1:${port}`
  const cookie = await getUiCookie(baseUrl)
  const sockets: WebSocket[] = []
  cleanups.push(async () => {
    for (const socket of sockets) socket.terminate()
    await store.close()
    await new Promise<void>((resolve) => app.server.close(() => resolve()))
    rmSync(dataDir, { recursive: true, force: true })
  })
  const workspace = store.createWorkspace(join(dataDir, 'workspace'), 'Remote terminal')
  const worker = store.addWorker(workspace.id, { name: 'Fixture', role: 'coder' })
  const script = join(workspace.path, 'terminal.cjs')
  mkdirSync(workspace.path, { recursive: true })
  writeFileSync(
    script,
    "if(process.stdin.isTTY)process.stdin.setRawMode(true);process.stdin.on('data',data=>process.stdout.write('ECHO:'+data));setInterval(()=>process.stdout.write('TICK\\r\\n'),100)"
  )
  store.configureAgentLaunch(workspace.id, worker.id, { command: process.execPath, args: [script] })
  await authorizeSyntheticAgent(store, workspace.id, worker.id)
  const run = await store.startAgent(workspace.id, worker.id, { hivePort: String(port) })
  const device = store.remote.devices.insert({
    id: randomUUID(),
    name: 'Phone',
    keys: { d2p: new Uint8Array(32).fill(1), p2d: new Uint8Array(32).fill(2) },
    devicePublicKey: new Uint8Array(32).fill(3),
  })
  store.remote.permissions.setReadScopes(device.id, [workspace.id])
  const headers = stampLoopbackHeaders({}, store.getRemoteTunnelSecret(), device.id)
  const grant = (actions: RemoteAction[], durationMs = 600000) => {
    const request = store.remote.permissions.request(device.id, {
      workspaceId: workspace.id,
      actions,
      durationMs,
    })
    return store.remote.permissions.approve(request.id)
  }
  const connect = async (path: string, desktop = false) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: desktop ? { cookie } : headers,
    })
    sockets.push(socket)
    const messages: string[] = []
    socket.on('message', (data) => messages.push(data.toString()))
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    return { socket, messages }
  }
  return { store, manager, run, device, workspace, connect, grant, dataDir, baseUrl, headers }
}

test('connected remote terminal stays readable while every write is checked through expiry and revocation', async () => {
  const ctx = await fixture()
  const size = ctx.manager.getTerminalSize(ctx.run.runId)
  const prefix = `/ws/terminal/${ctx.run.runId}`
  const control = await ctx.connect(`${prefix}/control?clientId=shared&cols=39&rows=11`)
  const io = await ctx.connect(`${prefix}/io?clientId=shared`)
  const desktop = await ctx.connect(`${prefix}/io?clientId=shared`, true)
  await waitFor(() =>
    expect(control.messages.some((text) => JSON.parse(text).type === 'restore')).toBe(true)
  )
  expect(ctx.manager.getTerminalSize(ctx.run.runId)).toEqual(size)
  control.socket.send(JSON.stringify({ type: 'restore_complete' }))
  control.socket.send(JSON.stringify({ type: 'output_ack', bytes: 100000 }))
  const initial = ctx.manager.getInputSequence(ctx.run.runId)
  const secret = `secret-${randomUUID()}`
  io.socket.send(secret)
  io.socket.send(Buffer.from(secret))
  for (const message of [
    { type: 'resize', cols: 42, rows: 12 },
    { type: 'stop' },
    { type: 'retry_session', request_id: randomUUID() },
  ])
    control.socket.send(JSON.stringify(message))
  await waitFor(() =>
    expect(io.messages.filter((text) => text.includes('Desktop approval')).length).toBe(2)
  )
  await waitFor(() =>
    expect(control.messages.filter((text) => text.includes('Desktop approval')).length).toBe(3)
  )
  expect(ctx.manager.getInputSequence(ctx.run.runId)).toBe(initial)
  expect(ctx.manager.getTerminalSize(ctx.run.runId)).toEqual(size)
  desktop.socket.send('LOCAL')
  await waitFor(() => expect(ctx.manager.getInputSequence(ctx.run.runId)).toBe(initial + 1))
  const approved = ctx.grant(['terminal_input', 'terminal_resize'], 1000)
  await waitFor(() =>
    expect(control.messages.some((text) => text.includes('terminal_input'))).toBe(true)
  )
  io.socket.send('ALLOWED')
  control.socket.send(JSON.stringify({ type: 'resize', cols: 72, rows: 20 }))
  await waitFor(() => expect(ctx.manager.getInputSequence(ctx.run.runId)).toBe(initial + 2))
  await waitFor(() =>
    expect(ctx.manager.getTerminalSize(ctx.run.runId)).toEqual({ cols: 72, rows: 20 })
  )
  await waitFor(() =>
    expect(ctx.store.remote.permissions.getAccess(ctx.device.id).grants).toEqual([])
  )
  const outputCount = io.messages.length
  io.socket.send(secret)
  control.socket.send(JSON.stringify({ type: 'stop' }))
  control.socket.send(JSON.stringify({ type: 'retry_session', request_id: randomUUID() }))
  await waitFor(() =>
    expect(io.messages.filter((text) => text.includes('Desktop approval')).length).toBe(3)
  )
  await waitFor(() =>
    expect(control.messages.filter((text) => text.includes('Desktop approval')).length).toBe(5)
  )
  expect(ctx.manager.getInputSequence(ctx.run.runId)).toBe(initial + 2)
  await waitFor(() => expect(io.messages.slice(outputCount).join('')).toContain('TICK'))
  const next = ctx.grant(['terminal_input'])
  io.socket.send('NEWGRANT')
  await waitFor(() => expect(ctx.manager.getInputSequence(ctx.run.runId)).toBe(initial + 3))
  ctx.store.remote.permissions.revokeGrant(next.id)
  io.socket.send(secret)
  await waitFor(() =>
    expect(io.messages.filter((text) => text.includes('Desktop approval')).length).toBe(4)
  )
  expect(ctx.manager.getInputSequence(ctx.run.runId)).toBe(initial + 3)
  const audit = ctx.store.remote.audit.list(1000)
  expect(JSON.stringify(audit)).not.toContain(secret)
  expect(audit).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        action: 'ws_input',
        result: 'rejected',
        business_action: 'terminal_input',
      }),
      expect.objectContaining({
        action: 'ws_input',
        result: 'ok',
        grant_id: approved.id,
        byte_count: 7,
      }),
      expect.objectContaining({ action: 'grant_expire', grant_id: approved.id }),
    ])
  )
  const other = ctx.store.createWorkspace(join(ctx.dataDir, 'other'), 'Other scope')
  ctx.store.remote.permissions.setReadScopes(ctx.device.id, [other.id])
  await waitFor(() => expect(io.socket.readyState).toBe(WebSocket.CLOSED))
  expect(desktop.socket.readyState).toBe(WebSocket.OPEN)
  expect(
    (await fetch(`${ctx.baseUrl}/api/runtime/runs/${ctx.run.runId}`, { headers: ctx.headers }))
      .status
  ).toBe(403)
  expect(
    (
      await fetch(`${ctx.baseUrl}/api/runtime/runs/${ctx.run.runId}/stop`, {
        method: 'POST',
        headers: ctx.headers,
      })
    ).status
  ).toBe(403)
  const refused = await new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(`${ctx.baseUrl.replace('http:', 'ws:')}${prefix}/io`, {
      headers: ctx.headers,
    })
    socket.once('error', reject)
    socket.once('unexpected-response', (_request, response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
      socket.terminate()
    })
  })
  expect(refused).toBe(403)
})

test('grant expiry during asynchronous launch preparation prevents the real PTY spawn', async () => {
  const ctx = await fixture()
  const worker = ctx.store.addWorker(ctx.workspace.id, { name: 'Delayed', role: 'coder' })
  ctx.store.configureAgentLaunch(ctx.workspace.id, worker.id, {
    command: process.execPath,
    args: [join(ctx.workspace.path, 'terminal.cjs')],
  })
  await authorizeSyntheticAgent(ctx.store, ctx.workspace.id, worker.id)
  const prepare = ctx.store.executionPolicies.prepare.bind(ctx.store.executionPolicies)
  ctx.store.executionPolicies.prepare = async (input) => {
    const prepared = await prepare(input)
    await new Promise((resolve) => setTimeout(resolve, 1100))
    return prepared
  }
  ctx.grant(['agent_start'], 1000)
  const response = await fetch(
    `${ctx.baseUrl}/api/workspaces/${ctx.workspace.id}/agents/${worker.id}/start`,
    {
      method: 'POST',
      headers: { ...ctx.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ hive_port: new URL(ctx.baseUrl).port }),
    }
  )
  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({ code: 'remote_grant_expired' })
  expect(ctx.store.getActiveRunByAgentId(ctx.workspace.id, worker.id)).toBeUndefined()
  expect(ctx.store.listAgentRuns(worker.id)).toEqual([])
  expect(ctx.store.getAgent(ctx.workspace.id, worker.id).status).toBe('stopped')
})

test('HTTP input waiting for a prompt cannot use a later grant after its original authorization expires', async () => {
  const ctx = await fixture()
  const orchestratorId = `${ctx.workspace.id}:orchestrator`
  const script = join(ctx.workspace.path, 'delayed-prompt.cjs')
  writeFileSync(
    script,
    "if(process.stdin.isTTY)process.stdin.setRawMode(true);process.stdin.on('data',data=>{if(data.toString().includes('SHOW_PROMPT'))process.stdout.write('\\r\\nType your message\\r\\n');else process.stdout.write('RECEIVED:'+data)});process.stdout.write('WAITING_FOR_PROMPT\\r\\n')"
  )
  ctx.store.configureAgentLaunch(ctx.workspace.id, orchestratorId, {
    command: process.execPath,
    args: [script],
    interactiveCommand: 'gemini',
    presetAugmentationDisabled: true,
  })
  await authorizeSyntheticAgent(ctx.store, ctx.workspace.id, orchestratorId)
  const run = await ctx.store.startAgent(ctx.workspace.id, orchestratorId, {
    hivePort: new URL(ctx.baseUrl).port,
  })
  await waitFor(() =>
    expect(ctx.store.getLiveRun(run.runId).output).toContain('WAITING_FOR_PROMPT')
  )
  const first = ctx.grant(['terminal_input'], 1000)
  const expiredText = `expired-http-text-${randomUUID()}`
  const send = (text: string) =>
    fetch(`${ctx.baseUrl}/api/workspaces/${ctx.workspace.id}/user-input`, {
      method: 'POST',
      headers: { ...ctx.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
  expect((await send(expiredText)).status).toBe(202)
  await waitFor(() =>
    expect(ctx.store.remote.permissions.getAccess(ctx.device.id).grants).toEqual([])
  )
  const next = ctx.grant(['terminal_input'])
  ctx.manager.writeInput(run.runId, 'SHOW_PROMPT')
  await waitFor(() =>
    expect(ctx.store.remote.audit.list(1000)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'http_input',
          resource_id: run.runId,
          grant_id: first.id,
          result: 'rejected',
          reject_reason: 'remote_grant_expired',
        }),
      ])
    )
  )
  expect(ctx.store.getLiveRun(run.runId).output).not.toContain(expiredText)
  const validText = `valid-http-text-${randomUUID()}`
  expect((await send(validText)).status).toBe(202)
  await waitFor(() => expect(ctx.store.getLiveRun(run.runId).output).toContain(validText))
  expect(ctx.store.remote.audit.list(1000)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        action: 'http_input',
        resource_id: run.runId,
        grant_id: next.id,
        result: 'ok',
      }),
    ])
  )
  expect(JSON.stringify(ctx.store.remote.audit.list(1000))).not.toContain(expiredText)
  expect(JSON.stringify(ctx.store.remote.audit.list(1000))).not.toContain(validText)
})

test('audit failure blocks real PTY input; tasks and terminal streams close when their read scope is revoked', async () => {
  const ctx = await fixture()
  ctx.grant(['terminal_input'])
  const io = await ctx.connect(`/ws/terminal/${ctx.run.runId}/io?clientId=audit`)
  const tasks = await ctx.connect(`/ws/tasks/${ctx.workspace.id}`)
  const sequence = ctx.manager.getInputSequence(ctx.run.runId)
  const db = new Database(join(ctx.dataDir, 'runtime.sqlite'), { fileMustExist: true })
  try {
    db.exec(
      "CREATE TRIGGER reject_remote_audit BEFORE INSERT ON remote_audit BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END"
    )
    io.socket.send('must-not-execute')
    await waitFor(() => expect(io.messages.join('')).toContain('synthetic audit failure'))
    expect(ctx.manager.getInputSequence(ctx.run.runId)).toBe(sequence)
    ctx.store.remote.audit.enqueue({ action: 'session_open', result: 'ok' })
    db.exec('DROP TRIGGER reject_remote_audit')
    expect(ctx.store.remote.permissions.getAccess(ctx.device.id).grants).toEqual([])
    io.socket.send('still-blocked-after-storage-recovers')
    await waitFor(() => expect(io.messages.join('')).toContain('Remote writes are disabled'))
    expect(ctx.manager.getInputSequence(ctx.run.runId)).toBe(sequence)
  } finally {
    db.close()
  }
  ctx.store.remote.devices.revoke(ctx.device.id)
  await waitFor(() => expect(tasks.socket.readyState).toBe(WebSocket.CLOSED))
  await waitFor(() => expect(io.socket.readyState).toBe(WebSocket.CLOSED))
})
