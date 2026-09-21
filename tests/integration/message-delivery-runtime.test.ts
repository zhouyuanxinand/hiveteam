import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, test } from 'vitest'
import { createTeamMailboxBroker } from '../../src/server/team-mailbox-broker.js'
import { startAuthorizedTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const setup = async () => {
  const server = await startAuthorizedTestServer()
  cleanups.push(server.close)
  const path = join(server.dataDir, 'workspace')
  mkdirSync(path)
  const workspace = server.store.createWorkspace(path, 'Delivery workspace')
  const worker = server.store.addWorker(workspace.id, { name: 'Coder', role: 'coder' })
  const marker = join(server.dataDir, 'input.txt')
  writeFileSync(marker, '')
  const script = join(server.dataDir, 'echo.cjs')
  writeFileSync(
    script,
    `const fs=require('node:fs');process.stdin.setEncoding('utf8');process.stdin.on('data',text=>fs.appendFileSync(${JSON.stringify(marker)},text));process.stdout.write('READY');process.stdin.resume()`
  )
  const start = async (agentId: string) => {
    server.store.configureAgentLaunch(workspace.id, agentId, {
      command: process.execPath,
      args: [script],
    })
    return server.store.startAgent(workspace.id, agentId, {
      hivePort: new URL(server.baseUrl).port,
    })
  }
  const cookie = await getUiCookie(server.baseUrl)
  const ui = async (path: string, method = 'GET', body?: unknown) =>
    fetch(server.baseUrl + path, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return { server, workspace, worker, marker, start, ui }
}

test('a stopped recipient resumes persisted report delivery without UI or team-list polling; unknown receipts are not repasted', async () => {
  const f = await setup(),
    id = `REPORT_${randomUUID()}`
  const dispatch = await f.server.store.dispatchTask(f.workspace.id, f.worker.id, 'Write tests')
  f.server.store.reportTask(f.workspace.id, f.worker.id, {
    dispatchId: dispatch.id,
    text: id,
    requireActiveRun: true,
  })
  const receipt = f.server.store.dispatchDelivery
    .view(f.workspace.id)
    .deliveries.find((entry) => entry.kind === 'report')
  expect(receipt?.state).toBe('pending')
  await f.start(`${f.workspace.id}:orchestrator`)
  await expect.poll(() => readFileSync(f.marker, 'utf8'), { timeout: 5000 }).toContain(id)
  await expect
    .poll(() => f.server.store.dispatchDelivery.records.get(receipt?.id ?? '')?.state)
    .toBe('unknown')
  const retry = f.server.store.reportTask(f.workspace.id, f.worker.id, {
    dispatchId: dispatch.id,
    text: id,
    requireActiveRun: true,
  })
  expect(retry.dispatch?.status).toBe('reported')
  for (let i = 0; i < 5; i++) {
    f.server.store.dispatchDelivery.wake()
    await f.server.store.dispatchDelivery.deliver(receipt?.id ?? '')
  }
  expect(readFileSync(f.marker, 'utf8').split(id)).toHaveLength(2)
  expect(f.server.store.dispatchDelivery.records.get(receipt?.id ?? '')).toMatchObject({
    id: receipt?.id,
    attempt: 1,
    evidence: 'pty_write',
  })
})

test('HTTP manual resolution requires a reason and composer acknowledgement, retains the original ID, and never exposes the private checkpoint', async () => {
  const f = await setup()
  await f.start(f.worker.id)
  const dispatch = await f.server.store.dispatchTask(
    f.workspace.id,
    f.worker.id,
    `TASK_${randomUUID()}`
  )
  await expect
    .poll(() => f.server.store.dispatchDelivery.records.get(dispatch.id)?.state, { timeout: 5000 })
    .toBe('unknown')
  const path = `/api/ui/workspaces/${f.workspace.id}/message-deliveries/${dispatch.id}/resolve`
  expect((await f.ui(path, 'POST', { action: 'resend', reason: 'try again' })).status).toBe(400)
  expect(f.server.store.dispatchDelivery.records.get(dispatch.id)?.attempt).toBe(1)
  const result = await f.ui(path, 'POST', {
    action: 'handled',
    reason: 'Verified the original task reached the CLI and cleared the composer',
    composer_safe: true,
  })
  expect(result.status).toBe(200)
  const payload = await result.json()
  expect(payload.deliveries[0]).toMatchObject({
    id: dispatch.id,
    state: 'resolved',
    evidence: 'manual',
  })
  expect(payload.deliveries[0]).not.toHaveProperty('checkpoint')
  const events = await f.ui(
    `/api/ui/workspaces/${f.workspace.id}/message-deliveries/${dispatch.id}/events`
  )
  expect(await events.json()).toMatchObject({
    delivery_events: expect.arrayContaining([
      expect.objectContaining({ actor: 'local_user', event: 'manual_resolution' }),
    ]),
  })
  const other = f.server.store.createWorkspace(join(f.server.dataDir, 'other'), 'Other')
  expect(
    (
      await f.ui(
        `/api/ui/workspaces/${other.id}/message-deliveries/${dispatch.id}/resolve`,
        'POST',
        { action: 'recheck' }
      )
    ).status
  ).toBe(404)
})

test('cancellation and late reports across HTTP preserve the other pending task and the live worker process', async () => {
  const f = await setup(),
    run = await f.start(f.worker.id)
  const first = await f.server.store.dispatchTask(f.workspace.id, f.worker.id, 'First task')
  const second = await f.server.store.dispatchTask(f.workspace.id, f.worker.id, 'Second task')
  const token = f.server.store.peekAgentToken(f.worker.id)
  if (!token) throw new Error('Expected live worker token')
  const post = (path: string, body: Record<string, unknown>) =>
    fetch(f.server.baseUrl + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: f.workspace.id,
        from_agent_id: f.worker.id,
        token,
        ...body,
      }),
    })
  f.server.store.cancelTask(f.workspace.id, first.id, {
    fromAgentId: `${f.workspace.id}:orchestrator`,
    reason: 'Stop only the first task',
  })
  const late = await post('/api/team/report', {
    dispatch_id: first.id,
    result: 'Late completion after cancellation',
    outcome: 'success',
  })
  expect(late.status).toBe(202)
  expect(await late.json()).toMatchObject({ late_report_id: expect.any(String), dispatch_id: null })
  expect(f.server.store.getDispatch(f.workspace.id, first.id)?.status).toBe('cancelled')
  expect(f.server.store.listWorkers(f.workspace.id)[0]?.pendingTaskCount).toBe(1)
  expect(f.server.store.getDispatch(f.workspace.id, second.id)?.status).not.toBe('reported')
  expect(f.server.store.getLiveRun(run.runId).status).toBe('running')
  const ack = await post('/api/team/status', {
    dispatch_id: first.id,
    progress_state: 'cancelled',
    result: 'This task has stopped',
  })
  expect(ack.status).toBe(202)
  expect(f.server.store.dispatchDelivery.health.get(first.id)?.cancellation_source).toBe(
    'worker_ack'
  )
})

test('timeout settings persist through HTTP and invalid settings leave saved values unchanged', async () => {
  const f = await setup(),
    path = `/api/ui/workspaces/${f.workspace.id}/dispatch-timeouts`
  const settings = {
    delivery_ms: 100,
    execution_ms: 3000,
    inactivity_ms: null,
    cancellation_ms: 1000,
  }
  expect((await f.ui(path, 'PUT', settings)).status).toBe(200)
  expect(await (await f.ui(path)).json()).toEqual(settings)
  expect((await f.ui(path, 'PUT', { ...settings, execution_ms: -1 })).status).toBe(400)
  expect(await (await f.ui(path)).json()).toEqual(settings)
  expect(
    (
      await fetch(f.server.baseUrl + path, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(settings),
      })
    ).status
  ).toBe(403)
})

test('real team CLI uses the bound mailbox for task progress, receipt and report visibility', async () => {
  const f = await setup(),
    run = await f.start(f.worker.id)
  const task = await f.server.store.dispatchTask(f.workspace.id, f.worker.id, 'Bound mailbox task')
  const token = f.server.store.peekAgentToken(f.worker.id)
  if (!token) throw new Error('Expected live worker token')
  const broker = await createTeamMailboxBroker({
    root: join(f.server.dataDir, 'mailbox'),
    workspaceId: f.workspace.id,
    agentId: f.worker.id,
    token,
    hivePort: new URL(f.server.baseUrl).port,
    isActive: () => f.server.store.getLiveRun(run.runId).status === 'running',
  })
  cleanups.push(() => broker.close())
  const cli = (args: string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'bin/team', ...args], {
        env: {
          ...process.env,
          HIVE_TEAM_MAILBOX: broker.path,
          HIVE_PORT: '1',
          HIVE_AGENT_ID: f.worker.id,
          HIVE_PROJECT_ID: f.workspace.id,
          HIVE_AGENT_TOKEN: 'mailbox-bound',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = '',
        stderr = ''
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, stdout, stderr }))
    })
  expect(
    await cli(['status', 'Received task', '--dispatch', task.id, '--progress', 'accepted'])
  ).toMatchObject({ code: 0 })
  expect(f.server.store.dispatchDelivery.records.get(task.id)?.evidence).toBe('worker_ack')
  expect(
    await cli([
      'status',
      'Waiting for approval',
      '--dispatch',
      task.id,
      '--progress',
      'waiting_permission',
    ])
  ).toMatchObject({ code: 0 })
  expect(f.server.store.dispatchDelivery.health.get(task.id)?.waiting_reason).toBe(
    'waiting_permission'
  )
  expect(await cli(['report', 'Completed through mailbox', '--dispatch', task.id])).toMatchObject({
    code: 0,
  })
  const other = f.server.store.addWorker(f.workspace.id, { name: 'Other member', role: 'coder' })
  const hidden = await f.server.store.dispatchTask(f.workspace.id, other.id, 'Private other task')
  const visibility = await cli(['deliveries'])
  expect(visibility.code).toBe(0)
  const view = JSON.parse(visibility.stdout)
  expect(view.deliveries.map((entry: { kind: string }) => entry.kind).sort()).toEqual([
    'dispatch',
    'report',
  ])
  expect(visibility.stdout).not.toContain(hidden.id)
  expect(f.server.store.getDispatch(f.workspace.id, task.id)?.status).toBe('reported')
}, 30_000)

test('database failure cannot partially cancel or report a task or change pending memory', async () => {
  const f = await setup()
  const task = await f.server.store.dispatchTask(f.workspace.id, f.worker.id, 'Atomic task')
  const db = new Database(join(f.server.dataDir, 'runtime.sqlite'))
  try {
    db.exec(
      "CREATE TRIGGER fail_health BEFORE UPDATE ON dispatch_health BEGIN SELECT RAISE(ABORT,'health unavailable'); END"
    )
    expect(() =>
      f.server.store.cancelTask(f.workspace.id, task.id, {
        fromAgentId: `${f.workspace.id}:orchestrator`,
        reason: 'Cancel',
      })
    ).toThrow('health unavailable')
    expect(f.server.store.getDispatch(f.workspace.id, task.id)?.status).toBe('queued')
    expect(
      f.server.store.dispatchDelivery.records.list(f.workspace.id).map((entry) => entry.kind)
    ).toEqual(['dispatch'])
    expect(f.server.store.listWorkers(f.workspace.id)[0]?.pendingTaskCount).toBe(1)
    expect(() =>
      f.server.store.reportTask(f.workspace.id, f.worker.id, {
        dispatchId: task.id,
        text: 'Done',
        requireActiveRun: true,
      })
    ).toThrow('health unavailable')
    expect(f.server.store.getDispatch(f.workspace.id, task.id)?.status).toBe('queued')
    expect(f.server.store.listWorkers(f.workspace.id)[0]?.pendingTaskCount).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS count FROM report_outbox').get()).toEqual({ count: 0 })
    expect(f.server.store.dispatchDelivery.records.get(task.id)?.state).toBe('pending')
  } finally {
    db.exec('DROP TRIGGER fail_health')
    db.close()
  }
})

test('stop-impact HTTP lists all open dispatches and leaves cancellation scoped to one task', async () => {
  const f = await setup(),
    run = await f.start(f.worker.id)
  const one = await f.server.store.dispatchTask(f.workspace.id, f.worker.id, 'Open task one')
  const two = await f.server.store.dispatchTask(f.workspace.id, f.worker.id, 'Open task two')
  const path = `/api/runtime/runs/${run.runId}/stop-impact`
  const response = await f.ui(path)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    run_id: run.runId,
    dispatches: [{ dispatch_id: one.id }, { dispatch_id: two.id }],
  })
  f.server.store.cancelTask(f.workspace.id, one.id, {
    fromAgentId: `${f.workspace.id}:orchestrator`,
    reason: 'Only one',
  })
  expect(await (await f.ui(path)).json()).toMatchObject({ dispatches: [{ dispatch_id: two.id }] })
  expect(f.server.store.getLiveRun(run.runId).status).toBe('running')
  expect((await fetch(f.server.baseUrl + path)).status).toBe(403)
})

test('an explicit HTTP resend retains its ID and audit and sends a second copy only after acknowledgement', async () => {
  const f = await setup()
  await f.start(f.worker.id)
  const text = `EXPLICIT_RESEND_${randomUUID()}`
  const task = await f.server.store.dispatchTask(f.workspace.id, f.worker.id, text)
  await expect
    .poll(() => f.server.store.dispatchDelivery.records.get(task.id)?.state)
    .toBe('unknown')
  const path = `/api/ui/workspaces/${f.workspace.id}/message-deliveries/${task.id}/resolve`
  const request = {
    action: 'resend',
    reason: 'Checked original execution and chose a repeat',
    composer_safe: true,
  }
  expect((await f.ui(path, 'POST', request)).status).toBe(400)
  expect(readFileSync(f.marker, 'utf8').split(text)).toHaveLength(2)
  expect((await f.ui(path, 'POST', { ...request, acknowledge_resend: true })).status).toBe(200)
  await expect
    .poll(() => readFileSync(f.marker, 'utf8').split(text).length, { timeout: 5000 })
    .toBe(3)
  expect(f.server.store.dispatchDelivery.records.get(task.id)).toMatchObject({
    id: task.id,
    attempt: 2,
  })
  const audit = await (await f.ui(`${path.replace('/resolve', '/events')}`)).json()
  expect(audit.delivery_events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event: 'explicit_resend',
        actor: 'local_user',
        reason: request.reason,
      }),
    ])
  )
})
