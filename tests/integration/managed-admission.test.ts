import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createAgentManager, type StartAgentInput } from '../../src/server/agent-manager.js'
import { createManagedExecution } from '../../src/server/managed-execution.js'
import { createResourceBudgetStore } from '../../src/server/resource-budget-store.js'
import { openRuntimeDatabase } from '../../src/server/runtime-database.js'
import { startAuthorizedTestServer } from '../helpers/test-server.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'hive-managed-admission-'))
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 5 }))
  const server = await startAuthorizedTestServer({ dataDir: join(root, 'data') })
  cleanups.push(() => server.close())
  const workspaces = []
  for (const name of ['a', 'b']) {
    const path = join(root, name)
    await mkdir(path)
    workspaces.push(server.store.createWorkspace(path, name))
  }
  const worker = (workspaceId: string) => {
    const member = server.store.addWorker(workspaceId, { name: randomUUID(), role: 'coder' })
    server.store.configureAgentLaunch(workspaceId, member.id, {
      command: process.execPath,
      args: ['-e', 'console.log("ADMITTED"); process.stdin.resume()'],
    })
    return member
  }
  const start = (workspaceId: string, agentId: string) =>
    server.store.startAgent(workspaceId, agentId, {
      hivePort: new URL(server.baseUrl).port,
    })
  return { ...server, root, workspaces, worker, start }
}
describe('real managed execution admission', { timeout: 20_000 }, () => {
  test('confirmed native exit keeps its slot until isolated checkout cleanup completes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hive-cleanup-barrier-'))
    cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 5 }))
    const db = openRuntimeDatabase()
    cleanups.push(() => {
      db.close()
    })
    const budget = createResourceBudgetStore(db, { runtimeInstanceId: randomUUID() })
    budget.updateLimits({ max_running_total: 1 }, { actor: 'local_user' })
    const manager = createAgentManager()
    let entered = () => {},
      release = () => {}
    const cleanupEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    const cleanupGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const execution = createManagedExecution(
      budget,
      budget.reserve({ workspaceId: 'fixture', executionKey: 'agent:cleanup', kind: 'worker' })
    )
    const run = await manager.startAgent({
      execution,
      agentId: 'cleanup',
      cwd: root,
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      afterNativeExit: async () => {
        entered()
        await cleanupGate
      },
    })
    cleanups.push(async () => {
      release()
      await manager.waitForRunExit?.(run.runId)
    })
    await cleanupEntered
    expect(manager.getRun(run.runId).status).toBe('exited')
    expect(budget.getSnapshot().occupancy.global).toBe(1)
    expect(() =>
      budget.reserve({
        workspaceId: 'fixture',
        executionKey: 'shell:next',
        kind: 'workspace_shell',
      })
    ).toThrow('global_limit')
    release()
    await manager.waitForRunExit?.(run.runId)
    expect(budget.getSnapshot().occupancy.global).toBe(0)
  })

  test('the lowest PTY boundary rejects missing or already used admission capabilities', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hive-required-lease-'))
    cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 5 }))
    const db = openRuntimeDatabase()
    cleanups.push(() => {
      db.close()
    })
    const budget = createResourceBudgetStore(db, { runtimeInstanceId: randomUUID() })
    const manager = createAgentManager()
    const marker = join(root, 'unauthorized.txt')
    const command = {
      agentId: 'boundary-fixture',
      command: process.execPath,
      cwd: root,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
    }
    await expect(manager.startAgent(command as StartAgentInput)).rejects.toMatchObject({
      code: 'resource_reservation_invalid',
    })
    expect(budget.getSnapshot().occupancy.global).toBe(0)
    const execution = createManagedExecution(
      budget,
      budget.reserve({
        workspaceId: 'fixture',
        executionKey: 'agent:boundary-fixture',
        kind: 'worker',
      })
    )
    const run = await manager.startAgent({
      ...command,
      args: ['-e', 'console.log("ONE CHILD"); process.stdin.resume()'],
      execution,
    })
    cleanups.push(async () => {
      manager.stopRun(run.runId)
      await manager.waitForRunExit?.(run.runId)
    })
    await expect(manager.startAgent({ ...command, execution })).rejects.toMatchObject({
      code: 'resource_reservation_invalid',
    })
    await vi.waitFor(() => expect(manager.getRun(run.runId).output).toContain('ONE CHILD'), {
      timeout: 8000,
    })
    expect(budget.getSnapshot().occupancy.global).toBe(1)
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('concurrent member and shell starts cannot overshoot global or workspace limits', async () => {
    const fixture = await setup()
    const [first, second] = fixture.workspaces
    if (!first || !second) throw new Error('Missing synthetic workspace')
    fixture.store.resources.updateLimits(
      { max_running_total: 3, max_running_per_workspace: 2 },
      { actor: 'local_user' }
    )
    const a = fixture.worker(first.id),
      b = fixture.worker(first.id),
      c = fixture.worker(second.id),
      d = fixture.worker(second.id)
    const attempts = await Promise.allSettled([
      fixture.start(first.id, a.id),
      fixture.start(first.id, b.id),
      fixture.store.startWorkspaceShell(first.id),
      fixture.start(second.id, c.id),
      fixture.start(second.id, d.id),
      fixture.store.startWorkspaceShell(second.id),
    ])
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(3)
    const denied = attempts.filter((result) => result.status === 'rejected')
    expect(denied).toHaveLength(3)
    for (const result of denied)
      if (result.status === 'rejected')
        expect(result.reason).toMatchObject({ code: 'resource_limit_reached', statusCode: 409 })
    const snapshot = fixture.store.resources.getSnapshot()
    expect(snapshot.occupancy.global).toBe(3)
    expect(Object.values(snapshot.occupancy.by_workspace).every((count) => count <= 2)).toBe(true)
    expect(snapshot.reservations.filter((item) => item.state === 'running')).toHaveLength(3)
    for (const result of attempts)
      if (result.status === 'fulfilled') {
        fixture.store.stopAgentRun(result.value.runId)
      }
    await vi.waitFor(() => expect(fixture.store.resources.getSnapshot().occupancy.global).toBe(0), {
      timeout: 8000,
    })
    const shell = await fixture.store.startWorkspaceShell(first.id)
    expect(fixture.store.resources.getSnapshot().occupancy.by_kind.workspace_shell).toBe(1)
    expect(fixture.store.closeWorkspaceShell(first.id, shell.runId)).toBe(true)
    expect(fixture.store.resources.getSnapshot().occupancy.global).toBe(1)
    await vi.waitFor(() => expect(fixture.store.resources.getSnapshot().occupancy.global).toBe(0), {
      timeout: 8000,
    })
  })
  test('preparation owns a slot and stop cancels a pending start before any PTY can appear', async () => {
    const fixture = await setup()
    const workspace = fixture.workspaces[0]
    if (!workspace) throw new Error('Missing synthetic workspace')
    fixture.store.resources.updateLimits({ max_running_total: 1 }, { actor: 'local_user' })
    const member = fixture.worker(workspace.id)
    let continuePreparation = () => {}
    const gate = new Promise<void>((resolve) => {
      continuePreparation = resolve
    })
    const original = fixture.store.executionPolicies.prepare.bind(fixture.store.executionPolicies)
    fixture.store.executionPolicies.prepare = async (input) => {
      await gate
      return original(input)
    }
    const pending = fixture.start(workspace.id, member.id)
    const outcome = pending.then(
      (run) => ({ run }),
      (error: unknown) => ({ error })
    )
    await vi.waitFor(() => expect(fixture.store.resources.getSnapshot().occupancy.global).toBe(1))
    expect(fixture.store.resources.getSnapshot().reservations[0]?.state).toBe('reserved')
    await expect(fixture.store.startWorkspaceShell(workspace.id)).rejects.toMatchObject({
      code: 'resource_limit_reached',
    })
    fixture.store.cancelPendingAgentStart(workspace.id, member.id)
    continuePreparation()
    expect(await outcome).toMatchObject({ error: { code: 'execution_cancelled' } })
    expect(fixture.store.listAgentRuns(member.id)).toEqual([])
    expect(fixture.store.getAgent(workspace.id, member.id).status).toBe('stopped')
    expect(fixture.store.peekAgentToken(member.id)).toBeUndefined()
    expect(fixture.store.resources.getSnapshot().occupancy.global).toBe(0)
  })
  test('a post-spawn SQLite failure kills the real child and only releases after native exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hive-spawn-failure-'))
    cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 5 }))
    const db = openRuntimeDatabase()
    cleanups.push(() => {
      db.close()
    })
    const resources = createResourceBudgetStore(db, { runtimeInstanceId: randomUUID() })
    const manager = createAgentManager()
    const reservation = resources.reserve({
      workspaceId: 'synthetic',
      executionKey: 'agent:synthetic',
      kind: 'worker',
    })
    const execution = createManagedExecution(resources, reservation)
    let pid: number | null = null
    const mark = execution.markStarted.bind(execution)
    execution.markStarted = (input) => {
      pid = input.pid
      mark(input)
    }
    db.exec(
      "CREATE TRIGGER fail_mark_started BEFORE UPDATE ON resource_reservations WHEN NEW.state='running' BEGIN SELECT RAISE(ABORT, 'synthetic start persistence failure'); END"
    )
    await expect(
      manager.startAgent({
        agentId: 'synthetic',
        command: process.execPath,
        args: ['-e', 'process.stdin.resume()'],
        cwd: root,
        execution,
      })
    ).rejects.toThrow('synthetic start persistence failure')
    expect(pid).toBeTypeOf('number')
    expect(resources.getSnapshot().occupancy.global).toBe(0)
    let exists = true
    try {
      if (pid === null) throw new Error('The synthetic process did not spawn')
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      exists = false
    }
    expect(exists).toBe(false)
    expect(resources.getReservation(reservation.id)).toMatchObject({
      state: 'released',
      reason: 'exit_confirmed',
    })
  })
})
