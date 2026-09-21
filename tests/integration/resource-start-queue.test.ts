import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { recheckRemoteAction } from '../../src/server/remote-action-context.js'
import { createResourceBudgetStore } from '../../src/server/resource-budget-store.js'
import { createResourceStartQueue } from '../../src/server/resource-start-queue.js'
import { openRuntimeDatabase } from '../../src/server/runtime-database.js'
import { createWorkspaceStore } from '../../src/server/workspace-store.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})
const setup = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hive-start-queue-'))
  cleanups.push(() =>
    rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  )
  const db = openRuntimeDatabase(directory)
  cleanups.push(() => {
    if (db.open) db.close()
  })
  const budget = createResourceBudgetStore(db, { runtimeInstanceId: randomUUID() })
  const workspaceStore = createWorkspaceStore(db, [])
  const a = workspaceStore.createWorkspace(directory, 'A')
  const b = workspaceStore.createWorkspace(directory, 'B')
  const workspaces = a.id.localeCompare(b.id) < 0 ? ([a, b] as const) : ([b, a] as const)
  const queue = createResourceStartQueue({
    db,
    budget,
    validateRemoteGrant: () => {
      throw new Error('Unexpected remote request')
    },
  })
  cleanups.push(() => queue.close())
  return { directory, db, budget, workspaceStore, workspaces, queue }
}

test('SQLite queue starts real processes in workspace round-robin and within-workspace FIFO', async () => {
  const { directory, budget, workspaces, queue } = await setup()
  budget.updateLimits(
    { max_running_total: 1, max_running_per_workspace: 1 },
    { actor: 'local_user' }
  )
  const marker = join(directory, 'started.txt')
  const children: ChildProcess[] = []
  cleanups.push(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          child.once('exit', () => resolve())
          child.kill()
        })
      }
  })
  const first = workspaces[0],
    second = workspaces[1]
  for (const [workspace, name] of [
    [first, 'A1'],
    [first, 'A2'],
    [second, 'B1'],
    [second, 'B2'],
  ] as const) {
    const entry = queue.enqueue({
      workspaceId: workspace.id,
      executionKey: name,
      kind: 'worker',
      source: 'scenario',
      payload: {},
    })
    expect(
      queue.enqueue({
        workspaceId: workspace.id,
        executionKey: name,
        kind: 'worker',
        source: 'scenario',
        payload: {},
      }).id
    ).toBe(entry.id)
  }
  queue.registerHandler('scenario', async (entry) => {
    expect(budget.getSnapshot().occupancy.global).toBe(1)
    budget.beginSpawn(entry.reservation_id)
    const runId = randomUUID()
    const child = spawn(
      process.execPath,
      [
        '-e',
        'require("node:fs").appendFileSync(process.argv[1],process.argv[2]+"\\n");setTimeout(()=>{},80)',
        marker,
        entry.execution_key,
      ],
      { windowsHide: true, stdio: 'ignore' }
    )
    children.push(child)
    budget.markStarted(entry.reservation_id, { runId, pid: child.pid ?? null })
    child.once('exit', () =>
      budget.release(entry.reservation_id, {
        reason: 'exit_confirmed',
        exitEvidence: {
          run_id: runId,
          pid: child.pid ?? null,
          ended_at: Date.now(),
          source: 'native_exit',
        },
      })
    )
    return { runId }
  })
  await expect
    .poll(() => queue.list().filter((entry) => entry.status === 'started').length, {
      timeout: 10000,
    })
    .toBe(4)
  await expect.poll(() => budget.getSnapshot().occupancy.global, { timeout: 10000 }).toBe(0)
  expect((await readFile(marker, 'utf8')).trim().split('\n')).toEqual(['A1', 'B1', 'A2', 'B2'])
  expect(queue.list().map((entry) => entry.attempts)).toEqual([1, 1, 1, 1])
})

test('cancelling a claimed start releases its unspawned lease and rejects its delayed side effect', async () => {
  const { budget, workspaces, queue } = await setup()
  let unblock = () => {}
  const gate = new Promise<void>((resolve) => {
    unblock = resolve
  })
  const entry = queue.enqueue({
    workspaceId: workspaces[0].id,
    executionKey: 'cancelled',
    kind: 'worker',
    source: 'scenario',
    payload: {},
  })
  let executed = false
  queue.registerHandler('scenario', async () => {
    await gate
    recheckRemoteAction()
    executed = true
    return { runId: 'unexpected' }
  })
  await expect.poll(() => queue.list()[0]?.status).toBe('starting')
  expect(budget.getSnapshot().occupancy.global).toBe(1)
  expect(queue.cancel(entry.id)?.status).toBe('cancelled')
  expect(queue.cancel(entry.id)?.status).toBe('cancelled')
  unblock()
  await queue.close()
  expect(executed).toBe(false)
  expect(queue.list()[0]?.status).toBe('cancelled')
  expect(budget.getSnapshot().occupancy.global).toBe(0)
})

test('pending requests and explicit orchestrator pause survive reopening the SQLite database', async () => {
  const { directory, db, budget, workspaceStore, workspaces, queue } = await setup()
  const workspace = workspaces[0]
  const orchestrator = `${workspace.id}:orchestrator`
  workspaceStore.markAgentManuallyStopped(workspace.id, orchestrator)
  const kept = queue.enqueue({
    workspaceId: workspace.id,
    agentId: orchestrator,
    executionKey: `agent:${orchestrator}`,
    kind: 'orchestrator',
    source: 'recovery',
    payload: {},
  })
  const cancelled = queue.enqueue({
    workspaceId: workspace.id,
    executionKey: 'cancel',
    kind: 'worker',
    source: 'scenario',
    payload: {},
  })
  queue.cancel(cancelled.id)
  await queue.close()
  expect(budget.getSnapshot().occupancy.global).toBe(0)
  db.close()
  const reopened = openRuntimeDatabase(directory)
  const next = createResourceStartQueue({
    db: reopened,
    budget: createResourceBudgetStore(reopened, { runtimeInstanceId: randomUUID() }),
    validateRemoteGrant: () => {},
  })
  try {
    expect(next.list().map((entry) => [entry.id, entry.status])).toEqual([
      [kept.id, 'queued'],
      [cancelled.id, 'cancelled'],
    ])
    expect(
      createWorkspaceStore(reopened, []).isAgentManuallyStopped(workspace.id, orchestrator)
    ).toBe(true)
  } finally {
    await next.close()
    reopened.close()
  }
})

test('a failed batch leaves neither persisted members nor in-memory members', async () => {
  const { db, workspaceStore, workspaces } = await setup()
  db.exec(
    "CREATE TRIGGER reject_second BEFORE INSERT ON workers WHEN NEW.name='second' BEGIN SELECT RAISE(ABORT,'batch rejected'); END"
  )
  expect(() =>
    workspaceStore.addWorkers(workspaces[0].id, [
      { name: 'first', role: 'coder' },
      { name: 'second', role: 'reviewer' },
    ])
  ).toThrow('batch rejected')
  expect(workspaceStore.listWorkers(workspaces[0].id)).toEqual([])
  expect(db.prepare('SELECT COUNT(*) AS count FROM workers').get()).toEqual({ count: 0 })
})

test('execution keys deduplicate within their workspace and cancellation callbacks finish before close', async () => {
  const { db, workspaces, queue } = await setup()
  const first = queue.enqueue({
    workspaceId: workspaces[0].id,
    executionKey: 'same-key',
    kind: 'verification',
    source: 'verification',
    payload: {},
  })
  const second = queue.enqueue({
    workspaceId: workspaces[1].id,
    executionKey: 'same-key',
    kind: 'verification',
    source: 'verification',
    payload: {},
  })
  expect(second.id).not.toBe(first.id)
  let release = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  queue.registerHandler('verification', async () => ({}), {
    cancel: async (entry) => {
      await pending
      db.prepare('UPDATE workspaces SET name=? WHERE id=?').run(
        'Cancellation complete',
        entry.workspace_id
      )
    },
  })
  queue.cancel(first.id)
  queue.cancel(second.id)
  let closed = false
  const closing = queue.close().then(() => {
    closed = true
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(closed).toBe(false)
  release()
  await closing
  expect(db.prepare('SELECT name FROM workspaces ORDER BY id').all()).toEqual([
    { name: 'Cancellation complete' },
    { name: 'Cancellation complete' },
  ])
})

test('the real scenario HTTP route rejects the entire team when membership capacity is insufficient', async () => {
  const server = await startTestServer()
  cleanups.push(() => server.close())
  const workspace = server.store.createWorkspace(server.dataDir, 'Capacity')
  const preset = server.store.settings.createCommandPreset({
    command: process.execPath,
    args: [],
    displayName: 'Node',
    env: {},
    resumeArgsTemplate: null,
    sessionIdCapture: null,
    yoloArgsTemplate: null,
  })
  server.store.resources.updateLimits({ max_workers_per_workspace: 2 }, { actor: 'local_user' })
  const response = await fetch(
    `${server.baseUrl}/api/ui/workspaces/${workspace.id}/team-scenarios/ship-feature`,
    {
      method: 'POST',
      headers: { cookie: await getUiCookie(server.baseUrl), 'content-type': 'application/json' },
      body: JSON.stringify({ autostart: false, command_preset_id: preset.id }),
    }
  )
  expect(response.status).toBe(409)
  expect((await response.json()).code).toBe('resource_limit_reached')
  expect(server.store.listWorkers(workspace.id)).toEqual([])
  server.store.resources.updateLimits({ max_workers_per_workspace: 3 }, { actor: 'local_user' })
  const accepted = await fetch(
    `${server.baseUrl}/api/ui/workspaces/${workspace.id}/team-scenarios/ship-feature`,
    {
      method: 'POST',
      headers: { cookie: await getUiCookie(server.baseUrl), 'content-type': 'application/json' },
      body: JSON.stringify({ autostart: false, command_preset_id: preset.id }),
    }
  )
  expect(accepted.status).toBe(201)
  expect((await accepted.json()).created).toHaveLength(3)
  expect(
    server.store
      .listWorkers(workspace.id)
      .every(
        (worker) =>
          server.store.peekAgentLaunchConfig(workspace.id, worker.id)?.command === process.execPath
      )
  ).toBe(true)
})
