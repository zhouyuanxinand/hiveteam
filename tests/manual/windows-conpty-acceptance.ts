import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'
import { startAuthorizedTestServer } from '../helpers/test-server.js'

if (process.platform !== 'win32') throw new Error('ConPTY acceptance requires Windows')
const result = resolve(process.argv[2] ?? '.validation/conpty.json')
const root = mkdtempSync(join(tmpdir(), 'hive-conpty-')),
  project = join(root, '中文 路径')
mkdirSync(project)
const wait = async (fn: () => boolean, timeout = 15000) => {
  const end = Date.now() + timeout
  while (!fn()) {
    if (Date.now() > end) throw new Error('ConPTY acceptance timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}
let server = await startAuthorizedTestServer({ dataDir: join(root, 'state') })
const sockets: WebSocket[] = []
try {
  const session = await fetch(`${server.baseUrl}/api/ui/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bootstrap_token: server.store.createUiBootstrap() }),
  })
  const cookie = session.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  const response = await fetch(`${server.baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      path: project,
      name: 'ConPTY 中文',
      initialization_mode: 'basic',
      autostart_orchestrator: false,
    }),
  })
  assert.equal(response.status, 201)
  const workspace = (await response.json()) as { id: string },
    worker = server.store.addWorker(workspace.id, { name: 'Fixture worker', role: 'coder' }),
    orch = `${workspace.id}:orchestrator`
  const shim = join(project, 'fixture cli.cmd')
  writeFileSync(
    shim,
    `@echo off\r\n"${process.execPath}" "${resolve('tests/fixtures/release-cli.cjs')}" "${resolve('src/cli/team.ts')}"\r\n`
  )
  for (const id of [orch, worker.id])
    server.store.configureAgentLaunch(workspace.id, id, { command: shim, args: [] })
  const orchestrator = await server.store.startAgent(workspace.id, orch, {
      hivePort: new URL(server.baseUrl).port,
    }),
    run = await server.store.startAgent(workspace.id, worker.id, {
      hivePort: new URL(server.baseUrl).port,
    })
  await wait(() => server.store.getLiveRun(run.runId).output.includes('READY 中文'))
  const childPid = Number(server.store.getLiveRun(run.runId).output.match(/CHILD_PID:(\d+)/u)?.[1])
  assert.ok(childPid)
  const connect = async () => {
    const id = crypto.randomUUID(),
      base = `${server.baseUrl.replace('http:', 'ws:')}/ws/terminal/${run.runId}`
    const control = new WebSocket(`${base}/control?clientId=${id}&snapshot=1`, {
        headers: { cookie },
      }),
      io = new WebSocket(`${base}/io?clientId=${id}&snapshot=1`, { headers: { cookie } })
    sockets.push(control, io)
    const received = { snapshot: '', text: '' }
    control.on('message', (raw) => {
      const m = JSON.parse(raw.toString())
      if (m.type === 'restore') received.snapshot = m.snapshot
    })
    io.on('message', (raw) => {
      received.text += raw.toString()
      if (control.readyState === 1)
        control.send(
          JSON.stringify({ type: 'output_ack', bytes: Buffer.byteLength(raw.toString()) })
        )
    })
    await Promise.all([once(io, 'open'), once(control, 'open')])
    return { io, control, received }
  }
  const first = await connect()
  first.io.send('中文输入\r')
  await wait(() => first.received.text.includes('ECHO:中文输入'))
  first.io.close()
  first.control.close()
  const second = await connect()
  await wait(() => second.received.snapshot.includes('中文输入'))
  server.store.writeRunInput(orchestrator.runId, 'HIVE_ACCEPT_SEND\r')
  await wait(() => server.store.listDispatches(workspace.id).some((d) => d.status === 'reported'))
  const dispatch = server.store.listDispatches(workspace.id).find((d) => d.status === 'reported')
  assert.ok(dispatch)
  server.store.acceptDispatchReport(workspace.id, dispatch.id, dispatch.reportRevision)
  // Stop the reporting fixture before creating the cancellation case. Otherwise
  // a legitimate fast report races cancellation and can win it.
  server.store.stopAgentRun(run.runId)
  await wait(() => server.store.getLiveRun(run.runId).status === 'exited')
  const pending = await server.store.dispatchTask(workspace.id, worker.id, 'Cancellation fixture')
  server.store.writeRunInput(orchestrator.runId, `HIVE_ACCEPT_CANCEL:${pending.id}\r`)
  await wait(() => server.store.getDispatch(workspace.id, pending.id)?.status === 'cancelled')
  await wait(() => {
    try {
      process.kill(childPid, 0)
      return false
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') return true
      throw e
    }
  })
  for (const socket of sockets) socket.terminate()
  await server.close()
  server = await startAuthorizedTestServer({ dataDir: join(root, 'state') })
  assert.equal(server.store.getDispatch(workspace.id, dispatch.id)?.status, 'reported')
  assert.equal(server.store.getDispatch(workspace.id, pending.id)?.status, 'cancelled')
  assert.equal(
    server.store
      .getWorkspaceSnapshot(workspace.id)
      .agents.every((agent) => agent.status === 'stopped'),
    true
  )
  const restarted = await server.store.startAgent(workspace.id, worker.id, {
    hivePort: new URL(server.baseUrl).port,
  })
  await wait(() => server.store.getLiveRun(restarted.runId).output.includes('READY 中文'))
  server.store.stopAgentRun(restarted.runId)
  await wait(() => server.store.getLiveRun(restarted.runId).status === 'exited')
  writeFileSync(
    result,
    JSON.stringify(
      {
        ok: true,
        node: process.version,
        platform: process.platform,
        pty_backend: 'ConPTY DLL',
        checks: [
          'HTTP basic workspace',
          'Chinese and space path',
          'cmd shim',
          'team send/report/cancel',
          'report acceptance',
          'UTF-8 input',
          'WebSocket snapshot reconnect',
          'PTY exit and grandchild cleanup',
          'runtime restart preserves dispatches',
          'explicit agent restart',
        ],
      },
      null,
      2
    )
  )
} finally {
  for (const socket of sockets) socket.terminate()
  await server.close()
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
