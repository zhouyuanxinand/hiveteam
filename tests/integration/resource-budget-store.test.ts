import { type ChildProcess, type ForkOptions, fork, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { createResourceBudgetStore } from '../../src/server/resource-budget-store.js'
import { openRuntimeDatabase } from '../../src/server/runtime-database.js'
import { acquireRuntimeOwner } from '../../src/server/runtime-owner-lock.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import type { Database } from '../../src/server/sqlite.js'
import type { ResourceReservation } from '../../src/shared/resource-budget.js'

const roots: string[] = []
const databases: Database[] = []
const children: ChildProcess[] = []
const processIds = new Set<number>()
const owners: Array<ReturnType<typeof acquireRuntimeOwner>> = []
const runtimes: Array<ReturnType<typeof createRuntimeStore>> = []
const fixture = fileURLToPath(new URL('../fixtures/resource-budget-process.ts', import.meta.url))
interface Reply {
  type: string
  code?: string
  message?: string
  pid?: number
  reservation?: ResourceReservation
  runtime_instance_id?: string
}
const nextMessage = (child: ChildProcess): Promise<Reply> =>
  new Promise((resolveReply, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Resource process did not respond'))
    }, 30_000)
    const cleanup = () => {
      clearTimeout(timeout)
      child.off('message', message)
      child.off('error', error)
    }
    const message = (value: unknown) => {
      cleanup()
      resolveReply(value as Reply)
    }
    const error = (value: Error) => {
      cleanup()
      reject(value)
    }
    child.once('message', message)
    child.once('error', error)
  })
const launch = async (mode: string, directory: string, instance = randomUUID()) => {
  const options: ForkOptions & { windowsHide: boolean } = {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
  }
  const child = fork(fixture, [mode, directory, instance], options)
  children.push(child)
  const ready = await nextMessage(child)
  return { child, ready }
}
const request = async (child: ChildProcess, input: Record<string, unknown>) => {
  const response = nextMessage(child)
  child.send(input)
  const result = await response
  if (result.pid) processIds.add(result.pid)
  return result
}
const kill = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exit = once(child, 'exit')
  child.kill('SIGKILL')
  await exit
}
const present = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}
const setup = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hive-resource-test-'))
  roots.push(directory)
  const db = openRuntimeDatabase(directory)
  databases.push(db)
  const resources = createResourceBudgetStore(db, { runtimeInstanceId: randomUUID() })
  return { directory, db, resources }
}
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const child of children.splice(0)) await kill(child)
  for (const pid of processIds) if (present(pid)) process.kill(pid, 'SIGKILL')
  processIds.clear()
  for (const db of databases.splice(0)) if (db.open) db.close()
  for (const owner of owners.splice(0)) owner.close()
  for (const directory of roots.splice(0)) {
    if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}hive-resource-test-`))
      throw new Error('Unexpected fixture directory')
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

describe('runtime owner and resource admission', () => {
  test('an EXCLUSIVE owner rejects another process and a directory alias, then permits acquisition after a crash', async () => {
    const { directory, db } = await setup()
    db.close()
    const first = await launch('owner', directory)
    expect(first.ready.type).toBe('ready')
    const second = await launch('owner', directory)
    expect(second.ready.code).toBe('runtime_already_owned')
    const alias = join(directory, 'alias')
    await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const throughAlias = await launch('owner', alias)
    expect(throughAlias.ready.code).toBe('runtime_already_owned')
    await kill(first.child)
    const next = await launch('owner', directory)
    expect(next.ready.type).toBe('ready')
    expect(next.ready.runtime_instance_id).not.toBe(first.ready.runtime_instance_id)
  }, 60_000)

  test('a failed runtime database initialization releases the independent owner connection', async () => {
    const { directory, db } = await setup()
    db.close()
    await writeFile(join(directory, 'runtime.sqlite'), 'synthetic invalid database')
    expect(() => createRuntimeStore({ dataDir: directory })).toThrow()
    const owner = acquireRuntimeOwner(directory)
    owners.push(owner)
    expect(owner.dataDir).toBeTruthy()
    expect(await readFile(join(directory, 'runtime.sqlite'), 'utf8')).toBe(
      'synthetic invalid database'
    )
  })

  test('six independent database writers can start only three real managed children under the same atomic cap', async () => {
    const { directory, resources } = await setup()
    resources.updateLimits(
      { max_running_total: 3, max_running_per_workspace: 2 },
      { actor: 'local_user' }
    )
    const instance = randomUUID()
    const writers = await Promise.all(
      Array.from({ length: 6 }, () => launch('writer', directory, instance))
    )
    expect(writers.every(({ ready }) => ready.type === 'ready')).toBe(true)
    const replies = await Promise.all(
      writers.map(({ child }, index) =>
        request(child, {
          operation: 'reserve',
          input: {
            workspaceId: index % 2 ? 'a' : 'b',
            executionKey: `run-${index}`,
            kind:
              index === 0
                ? 'verification'
                : index === 1
                  ? 'orchestrator'
                  : index === 2
                    ? 'workspace_shell'
                    : 'worker',
          },
        })
      )
    )
    const admitted = replies.filter((reply) => reply.type === 'reserved')
    expect(admitted).toHaveLength(3)
    expect(replies.filter((reply) => reply.code === 'resource_limit_reached')).toHaveLength(3)
    expect(admitted.every((reply) => reply.pid && present(reply.pid))).toBe(true)
    expect(resources.getSnapshot().occupancy.global).toBe(3)
    expect(
      Object.values(resources.getSnapshot().occupancy.by_workspace).every((count) => count <= 2)
    ).toBe(true)
  }, 60_000)

  test('deduplication, kind quotas, lower limits and exit evidence keep occupancy consistent', async () => {
    const { resources } = await setup()
    const worker = resources.reserve({
      workspaceId: 'a',
      executionKey: 'agent:w',
      kind: 'worker',
      agentId: 'w',
    })
    expect(
      resources.reserve({ workspaceId: 'a', executionKey: 'agent:w', kind: 'worker', agentId: 'w' })
        .id
    ).toBe(worker.id)
    const verification = resources.reserve({
      workspaceId: 'a',
      executionKey: 'verification:1',
      kind: 'verification',
      agentId: 'w',
    })
    expect(verification.id).not.toBe(worker.id)
    expect(() =>
      resources.reserve({ workspaceId: 'a', executionKey: 'verification:2', kind: 'verification' })
    ).toThrow(expect.objectContaining({ reason: 'verification_limit' }))
    resources.beginSpawn(worker.id)
    expect(() => resources.beginSpawn(worker.id)).toThrow(
      expect.objectContaining({ code: 'resource_reservation_invalid' })
    )
    resources.markStarted(worker.id, { runId: 'native-run', pid: process.pid })
    expect(() => resources.release(worker.id, { reason: 'spawn_not_started' })).toThrow(
      expect.objectContaining({ code: 'resource_reservation_invalid' })
    )
    expect(() =>
      resources.release(worker.id, {
        reason: 'exit_confirmed',
        exitEvidence: {
          run_id: 'other',
          pid: process.pid,
          ended_at: Date.now(),
          source: 'native_exit',
        },
      })
    ).toThrow(expect.objectContaining({ code: 'resource_reservation_invalid' }))
    resources.updateLimits({ max_running_total: 1 }, { actor: 'local_user' })
    expect(resources.getSnapshot().occupancy.global).toBe(2)
    expect(() =>
      resources.reserve({ workspaceId: 'b', executionKey: 'shell', kind: 'workspace_shell' })
    ).toThrow(expect.objectContaining({ reason: 'global_limit' }))
    resources.release(verification.id, { reason: 'spawn_not_started' })
    resources.release(verification.id, { reason: 'spawn_not_started' })
    expect(resources.getSnapshot().occupancy.global).toBe(1)
  })

  test('limit update and audit persist together, and rollback does not change effective limits', async () => {
    const { db, resources } = await setup()
    resources.updateLimits({ max_running_total: 5 }, { actor: 'local_user' })
    const audit = db
      .prepare('SELECT actor, before_json, after_json, created_at FROM resource_limit_audit')
      .get() as { actor: string; before_json: string; after_json: string; created_at: number }
    expect(audit.actor).toBe('local_user')
    expect(JSON.parse(audit.before_json).max_running_total).toBe(8)
    expect(JSON.parse(audit.after_json).max_running_total).toBe(5)
    expect(audit.created_at).toBeGreaterThan(0)
    db.exec(
      `CREATE TRIGGER reject_resource_audit BEFORE INSERT ON resource_limit_audit BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END`
    )
    expect(() => resources.updateLimits({ max_running_total: 9 }, { actor: 'local_user' })).toThrow(
      'synthetic audit failure'
    )
    expect(resources.getLimits().max_running_total).toBe(5)
    expect(() =>
      resources.updateLimits({ max_running_total: 0 }, { actor: 'local_user' })
    ).toThrow()
  })

  test('reconciliation retries blocked exit persistence without skipping current native cleanup barriers', async () => {
    const { db, resources } = await setup()
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    children.push(child)
    await once(child, 'spawn')
    if (!child.pid) throw new Error('Fixture child has no process identity')
    const execution = resources.reserve({
      workspaceId: 'a',
      executionKey: 'worker',
      kind: 'worker',
    })
    resources.beginSpawn(execution.id)
    resources.markStarted(execution.id, { runId: 'native-run', pid: child.pid })
    const preparing = resources.reserve({
      workspaceId: 'a',
      executionKey: 'preparing',
      kind: 'worker',
    })
    const unknown = resources.reserve({ workspaceId: 'a', executionKey: 'unknown', kind: 'worker' })
    resources.beginSpawn(unknown.id)
    resources.markRecoveryBlocked(unknown.id)
    await kill(child)
    expect(present(child.pid)).toBe(false)

    resources.recover()
    expect(resources.getReservation(execution.id)?.state).toBe('running')
    expect(resources.getReservation(preparing.id)?.state).toBe('reserved')
    expect(resources.getReservation(unknown.id)?.state).toBe('recovery_blocked')
    expect(resources.getSnapshot().occupancy.global).toBe(3)

    db.exec(`CREATE TRIGGER reject_execution_release BEFORE UPDATE OF state ON resource_reservations
      WHEN NEW.state = 'released' BEGIN SELECT RAISE(ABORT, 'synthetic exit write failure'); END`)
    expect(() =>
      resources.release(execution.id, {
        reason: 'exit_confirmed',
        exitEvidence: {
          run_id: 'native-run',
          pid: child.pid ?? null,
          ended_at: Date.now(),
          source: 'native_exit',
        },
      })
    ).toThrow('synthetic exit write failure')
    resources.markRecoveryBlocked(execution.id, 'exit_persistence_failed')
    expect(() => resources.recover()).toThrow('synthetic exit write failure')
    expect(resources.getSnapshot().occupancy.global).toBe(3)
    db.exec('DROP TRIGGER reject_execution_release')
    resources.recover()
    expect(resources.getReservation(execution.id)).toMatchObject({
      state: 'released',
      reason: 'process_absent',
    })
    expect(resources.getReservation(preparing.id)?.state).toBe('reserved')
    expect(resources.getReservation(unknown.id)?.state).toBe('recovery_blocked')
    expect(resources.getSnapshot().occupancy.global).toBe(2)
  })

  test('concurrent member batches cannot leave a partial scenario or exceed the durable member cap', async () => {
    const { directory, db, resources } = await setup()
    resources.updateLimits({ max_workers_per_workspace: 3 }, { actor: 'local_user' })
    db.prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(?,?,?,?)').run(
      'a',
      'Concurrent members',
      directory,
      Date.now()
    )
    const writers = await Promise.all([launch('writer', directory), launch('writer', directory)])
    expect(writers.map(({ ready }) => ready)).toEqual([
      expect.objectContaining({ type: 'ready' }),
      expect.objectContaining({ type: 'ready' }),
    ])
    const replies = await Promise.all(
      writers.map(({ child }) =>
        request(child, { operation: 'members', count: 2, input: { workspaceId: 'a' } })
      )
    )
    expect(replies.filter((reply) => reply.type === 'members')).toHaveLength(1)
    expect(replies.filter((reply) => reply.code === 'resource_limit_reached')).toHaveLength(1)
    expect(
      (
        db.prepare(`SELECT COUNT(*) AS count FROM workers WHERE workspace_id = 'a'`).get() as {
          count: number
        }
      ).count
    ).toBe(2)
  }, 60_000)

  test('recovery releases a reservation never sent to spawn but retains an unknown child created before PID persistence', async () => {
    const { directory, resources } = await setup()
    const owner = await launch('crash', directory)
    const reserved = await request(owner.child, {
      operation: 'reserve',
      phase: 'reserved',
      input: { workspaceId: 'a', executionKey: 'reserved', kind: 'worker' },
    })
    const unknown = await request(owner.child, {
      operation: 'reserve',
      phase: 'spawn_unknown',
      input: { workspaceId: 'a', executionKey: 'unknown', kind: 'workspace_shell' },
    })
    expect(unknown.pid && present(unknown.pid)).toBe(true)
    await kill(owner.child)
    resources.recover()
    expect(resources.getReservation(reserved.reservation?.id ?? '')?.state).toBe('released')
    expect(resources.getReservation(unknown.reservation?.id ?? '')).toMatchObject({
      state: 'recovery_blocked',
      pid: null,
      reason: 'unknown_process_identity',
    })
    expect(resources.getSnapshot().occupancy.global).toBe(1)
    expect(() =>
      resources.reserve({ workspaceId: 'a', executionKey: 'unknown', kind: 'workspace_shell' })
    ).toThrow(expect.objectContaining({ reason: 'recovery_pending' }))
  }, 60_000)

  test('a recorded child survives owner failure, keeps its slot, and releases only after confirmed process absence', async () => {
    const { directory, resources } = await setup()
    const owner = await launch('crash', directory)
    const started = await request(owner.child, {
      operation: 'reserve',
      input: { workspaceId: 'a', executionKey: 'agent:worker', kind: 'worker', agentId: 'worker' },
    })
    expect(started.pid && present(started.pid)).toBe(true)
    await kill(owner.child)
    resources.recover()
    expect(resources.getReservation(started.reservation?.id ?? '')?.state).toBe('recovery_blocked')
    expect(resources.getSnapshot().occupancy.global).toBe(1)
    if (!started.pid) throw new Error('Fixture did not start a real child')
    process.kill(started.pid, 'SIGKILL')
    await expect.poll(() => present(started.pid ?? 0), { timeout: 10_000 }).toBe(false)
    resources.recover()
    expect(resources.getReservation(started.reservation?.id ?? '')).toMatchObject({
      state: 'released',
      reason: 'process_absent',
    })
    expect(
      resources.reserve({
        workspaceId: 'a',
        executionKey: 'agent:worker',
        kind: 'worker',
        agentId: 'worker',
      }).id
    ).not.toBe(started.reservation?.id)
  }, 60_000)

  test('runtime initialization captures legacy agent and verification processes before stale-run mutation and preserves them across clean restarts', async () => {
    const { directory, db } = await setup()
    const workspaceId = randomUUID()
    const agentId = randomUUID()
    const runId = randomUUID()
    const verificationId = randomUUID()
    const dispatchId = randomUUID()
    const now = Date.now()
    db.prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(?,?,?,?)').run(
      workspaceId,
      'Legacy workspace',
      directory,
      now
    )
    db.prepare('INSERT INTO workers(id,workspace_id,name,role,created_at) VALUES(?,?,?,?,?)').run(
      agentId,
      workspaceId,
      'Legacy worker',
      'coder',
      now
    )
    db.prepare(
      `INSERT INTO agent_runs(run_id,agent_id,status,pid,started_at,created_at,updated_at) VALUES(?,?,'running',NULL,?,?,?)`
    ).run(runId, agentId, now, now, now)
    db.prepare(`INSERT INTO dispatches(id,workspace_id,to_agent_id,text,status,created_at)
      VALUES(?,?,?,'Legacy work','reported',?)`).run(dispatchId, workspaceId, agentId, now)
    db.prepare(`INSERT INTO dispatch_verifications(id,workspace_id,dispatch_id,report_revision,head_sha,command,state,started_at)
      VALUES(?,?,?,1,?,'synthetic old verification','running',?)`).run(
      verificationId,
      workspaceId,
      dispatchId,
      'a'.repeat(40),
      now
    )
    db.close()
    const runtime = createRuntimeStore({ dataDir: directory })
    runtimes.push(runtime)
    const snapshot = runtime.resources.getSnapshot()
    expect(snapshot.occupancy.global).toBe(2)
    expect(snapshot.reservations.find((row) => row.run_id === runId)).toMatchObject({
      workspace_id: workspaceId,
      agent_id: agentId,
      run_id: runId,
      state: 'recovery_blocked',
      reason: 'unknown_process_identity',
    })
    expect(snapshot.reservations.find((row) => row.run_id === verificationId)).toMatchObject({
      workspace_id: workspaceId,
      agent_id: agentId,
      kind: 'verification',
      pid: null,
      state: 'recovery_blocked',
      reason: 'unknown_process_identity',
    })
    const inspection = openRuntimeDatabase(directory)
    databases.push(inspection)
    expect(
      inspection
        .prepare('SELECT state FROM dispatch_verifications WHERE id = ?')
        .get(verificationId)
    ).toEqual({ state: 'interrupted' })
    expect(() => createRuntimeStore({ dataDir: directory })).toThrow(
      expect.objectContaining({ code: 'runtime_already_owned' })
    )
    expect(() =>
      runtime.resources.reserve({
        workspaceId,
        agentId,
        executionKey: `agent:${agentId}`,
        kind: 'worker',
      })
    ).toThrow(expect.objectContaining({ reason: 'recovery_pending' }))
    await runtime.close()
    runtimes.splice(runtimes.indexOf(runtime), 1)
    const reopened = createRuntimeStore({ dataDir: directory })
    runtimes.push(reopened)
    expect(reopened.resources.runtimeInstanceId).not.toBe(runtime.resources.runtimeInstanceId)
    expect(
      reopened.resources
        .getSnapshot()
        .reservations.map((row) => row.id)
        .sort()
    ).toEqual(snapshot.reservations.map((row) => row.id).sort())
  })
})
