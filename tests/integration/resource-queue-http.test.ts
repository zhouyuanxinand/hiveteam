import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { stampLoopbackHeaders } from '../../src/server/remote-loopback-auth.js'
import Database from '../../src/server/sqlite.js'
import { authorizeSyntheticAgent } from '../helpers/authorized-runtime.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})
const fixture = async () => {
  const server = await startTestServer()
  servers.push(server)
  const workspace = server.store.createWorkspace(
    join(server.dataDir, 'workspace'),
    'Queued workflow'
  )
  const root = join(workspace.path, '.hive', 'workflows')
  await mkdir(root, { recursive: true })
  const task = `RESOURCE_QUEUE_TASK_${randomUUID()}`
  await writeFile(
    join(root, 'queued.json'),
    JSON.stringify({ name: 'Queue', steps: [{ id: 'implement', worker: 'Builder', task }] })
  )
  const worker = server.store.addWorker(workspace.id, { name: 'Builder', role: 'coder' })
  const marker = join(server.dataDir, 'worker-input.txt')
  await writeFile(marker, '')
  const script = join(workspace.path, 'worker.cjs')
  await writeFile(
    script,
    'const fs=require("node:fs");if(process.stdin.isTTY)process.stdin.setRawMode(true);process.stdin.on("data",data=>fs.appendFileSync(process.argv[2],data));process.stdout.write("READY\\n");'
  )
  server.store.configureAgentLaunch(workspace.id, worker.id, {
    command: process.execPath,
    args: [script, marker],
  })
  await authorizeSyntheticAgent(server.store, workspace.id, worker.id)
  server.store.resources.updateLimits({ max_running_total: 1 }, { actor: 'local_user' })
  const blocker = server.store.resources.reserve({
    workspaceId: workspace.id,
    executionKey: 'preparing-shell',
    kind: 'workspace_shell',
  })
  const headers = { 'content-type': 'application/json', cookie: await getUiCookie(server.baseUrl) }
  const start = async (customHeaders: Record<string, string> = headers) => {
    const response = await fetch(
      `${server.baseUrl}/api/ui/workspaces/${workspace.id}/workflows/runs`,
      {
        method: 'POST',
        headers: customHeaders,
        body: JSON.stringify({ workflow_id: 'queued.json' }),
      }
    )
    expect(response.status).toBe(201)
    const run = (await response.json()) as {
      id: string
      steps: Array<{ dispatch_id: string; status: string }>
    }
    expect(run.steps[0]?.status).toBe('queued')
    const dispatchId = run.steps[0]?.dispatch_id
    if (!dispatchId) throw new Error('Workflow did not persist its dispatch')
    expect(server.store.getDispatch(workspace.id, dispatchId)?.status).toBe('queued')
    expect(server.store.listTerminalRuns(workspace.id)).toEqual([])
    expect(server.store.resourceQueue.list(workspace.id)[0]).toMatchObject({
      source: 'dispatch',
      status: 'queued',
      reason: 'global_limit',
    })
    return { runId: run.id, dispatchId }
  }
  const release = () => server.store.resources.release(blocker.id, { reason: 'spawn_not_started' })
  return { server, workspace, worker, marker, headers, start, release, task }
}

test('HTTP workflow dispatch stays queued until its real PTY receives the task after capacity is released', async () => {
  const ctx = await fixture()
  const { runId, dispatchId } = await ctx.start()
  expect(await readFile(ctx.marker, 'utf8')).toBe('')
  ctx.release()
  await expect
    .poll(() => ctx.server.store.getDispatch(ctx.workspace.id, dispatchId)?.status, {
      timeout: 10000,
    })
    .toBe('submitted')
  await expect.poll(() => readFile(ctx.marker, 'utf8'), { timeout: 10000 }).toContain(ctx.task)
  expect(ctx.server.store.workflows.get(ctx.workspace.id, runId)?.steps[0]?.status).toBe('running')
  expect(ctx.server.store.getWorker(ctx.workspace.id, ctx.worker.id)).toMatchObject({
    status: 'working',
    pendingTaskCount: 1,
  })
  expect((await readFile(ctx.marker, 'utf8')).split(ctx.task)).toHaveLength(2)
  expect(ctx.server.store.resourceQueue.list(ctx.workspace.id)[0]?.status).toBe('started')
  expect(ctx.server.store.resources.getSnapshot().occupancy.global).toBe(1)
})

test('stopping a workflow cancels its queued start and it cannot revive when resources become free', async () => {
  const ctx = await fixture()
  const { runId, dispatchId } = await ctx.start()
  const stopped = await fetch(
    `${ctx.server.baseUrl}/api/ui/workspaces/${ctx.workspace.id}/workflows/runs/${runId}/stop`,
    { method: 'POST', headers: ctx.headers, body: '{}' }
  )
  expect(stopped.status).toBe(200)
  expect(ctx.server.store.getDispatch(ctx.workspace.id, dispatchId)?.status).toBe('cancelled')
  expect(ctx.server.store.resourceQueue.list(ctx.workspace.id)[0]?.status).toBe('cancelled')
  const canary = ctx.server.store.addWorker(ctx.workspace.id, { name: 'Canary', role: 'coder' })
  ctx.server.store.configureAgentLaunch(ctx.workspace.id, canary.id, {
    command: process.execPath,
    args: ['-e', 'process.stdin.resume()'],
  })
  await authorizeSyntheticAgent(ctx.server.store, ctx.workspace.id, canary.id)
  ctx.server.store.resourceQueue.enqueue({
    workspaceId: ctx.workspace.id,
    agentId: canary.id,
    executionKey: `agent:${canary.id}`,
    kind: 'worker',
    source: 'scenario',
    payload: {},
  })
  ctx.release()
  await expect
    .poll(() => ctx.server.store.listTerminalRuns(ctx.workspace.id).map((run) => run.agent_id), {
      timeout: 10000,
    })
    .toEqual([canary.id])
  expect(ctx.server.store.resources.getSnapshot().occupancy.global).toBe(1)
  expect(await readFile(ctx.marker, 'utf8')).toBe('')
})

test('a later remote grant cannot revive queued work authorized by a revoked original grant', async () => {
  const ctx = await fixture()
  const device = ctx.server.store.remote.devices.insert({
    id: randomUUID(),
    name: 'Phone',
    keys: { d2p: new Uint8Array(32).fill(1), p2d: new Uint8Array(32).fill(2) },
    devicePublicKey: new Uint8Array(32).fill(3),
  })
  ctx.server.store.remote.permissions.setReadScopes(device.id, [ctx.workspace.id])
  const approve = () => {
    const request = ctx.server.store.remote.permissions.request(device.id, {
      workspaceId: ctx.workspace.id,
      actions: ['workflow_manage', 'agent_start'],
    })
    return ctx.server.store.remote.permissions.approve(request.id)
  }
  const original = approve()
  const headers = stampLoopbackHeaders(
    { 'content-type': 'application/json' },
    ctx.server.store.getRemoteTunnelSecret(),
    device.id
  )
  const { dispatchId } = await ctx.start(headers)
  ctx.server.store.remote.permissions.revokeGrant(original.id)
  const replacement = approve()
  expect(replacement.id).not.toBe(original.id)
  ctx.release()
  await expect
    .poll(() => ctx.server.store.resourceQueue.list(ctx.workspace.id)[0]?.status, {
      timeout: 10000,
    })
    .toBe('failed')
  expect(ctx.server.store.listTerminalRuns(ctx.workspace.id)).toEqual([])
  expect(ctx.server.store.resources.getSnapshot().occupancy.global).toBe(0)
  // A local start still must not replay the expired remote task into its new PTY.
  const localTask = `LOCAL_TASK_${randomUUID()}`
  const localDispatch = await ctx.server.store.dispatchTask(
    ctx.workspace.id,
    ctx.worker.id,
    localTask
  )
  expect(localDispatch.status).toBe('queued')
  await ctx.server.store.startAgent(ctx.workspace.id, ctx.worker.id, {
    hivePort: new URL(ctx.server.baseUrl).port,
  })
  await expect
    .poll(() => ctx.server.store.getDispatch(ctx.workspace.id, dispatchId)?.status, {
      timeout: 10000,
    })
    .toBe('failed')
  await expect
    .poll(() => ctx.server.store.getDispatch(ctx.workspace.id, localDispatch.id)?.status, {
      timeout: 1000,
    })
    .toBe('submitted')
  await expect.poll(() => readFile(ctx.marker, 'utf8'), { timeout: 10000 }).toContain(localTask)
  expect(await readFile(ctx.marker, 'utf8')).not.toContain(ctx.task)
})

test('queued remote execution fails closed when its execution audit cannot be persisted', async () => {
  const ctx = await fixture()
  const device = ctx.server.store.remote.devices.insert({
    id: randomUUID(),
    name: 'Phone audit',
    keys: { d2p: new Uint8Array(32).fill(1), p2d: new Uint8Array(32).fill(2) },
    devicePublicKey: new Uint8Array(32).fill(3),
  })
  ctx.server.store.remote.permissions.setReadScopes(device.id, [ctx.workspace.id])
  const request = ctx.server.store.remote.permissions.request(device.id, {
    workspaceId: ctx.workspace.id,
    actions: ['workflow_manage', 'agent_start'],
  })
  ctx.server.store.remote.permissions.approve(request.id)
  const headers = stampLoopbackHeaders(
    { 'content-type': 'application/json' },
    ctx.server.store.getRemoteTunnelSecret(),
    device.id
  )
  await ctx.start(headers)
  const db = new Database(join(ctx.server.dataDir, 'runtime.sqlite'))
  try {
    db.exec(
      "CREATE TRIGGER fail_queued_audit BEFORE INSERT ON remote_audit WHEN NEW.endpoint='resource_queue' AND NEW.result='authorized' BEGIN SELECT RAISE(ABORT,'execution audit unavailable'); END"
    )
  } finally {
    db.close()
  }
  ctx.release()
  await expect
    .poll(() => ctx.server.store.resourceQueue.list(ctx.workspace.id)[0], { timeout: 10000 })
    .toMatchObject({ status: 'failed', reason: 'execution audit unavailable' })
  expect(ctx.server.store.listTerminalRuns(ctx.workspace.id)).toEqual([])
  expect(ctx.server.store.resources.getSnapshot().occupancy.global).toBe(0)
  expect(await readFile(ctx.marker, 'utf8')).toBe('')
})
