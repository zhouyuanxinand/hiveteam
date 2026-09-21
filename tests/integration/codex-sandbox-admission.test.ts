import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { verifyCodexSandbox } from '../../src/server/codex-sandbox-probe.js'
import { createManagedExecution } from '../../src/server/managed-execution.js'
import { createResourceBudgetStore } from '../../src/server/resource-budget-store.js'
import { openRuntimeDatabase } from '../../src/server/runtime-database.js'

test('cancelling sandbox preparation retains its reservation until the real child exits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hive-sandbox-admission-'))
  const db = openRuntimeDatabase()
  const budget = createResourceBudgetStore(db, { runtimeInstanceId: randomUUID() })
  budget.updateLimits({ max_running_total: 1 }, { actor: 'local_user' })
  const workspacePath = join(root, 'workspace')
  const cliHome = join(root, 'cli-home')
  const scratchPath = join(root, 'scratch')
  const pidFile = join(root, 'probe-pid.json')
  let pid: number | undefined
  let completion: Promise<unknown> | undefined
  const abort = new AbortController()
  const stopFixture = () => {
    if (pid === undefined) return
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  try {
    await Promise.all([workspacePath, cliHome, scratchPath].map((path) => mkdir(path)))
    // Node interprets the probe's first "sandbox" argument as this fixture file.
    // This keeps the production spawn path real on Windows and Linux without
    // requiring a certified vendor binary or executing a model request.
    await writeFile(
      join(workspacePath, 'sandbox'),
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({pid: process.pid})); setInterval(() => {}, 1000);`
    )
    const execution = createManagedExecution(
      budget,
      budget.reserve({ workspaceId: 'fixture', executionKey: 'agent:probe', kind: 'worker' }),
      abort.signal
    )
    const input = {
      executable: process.execPath,
      workspacePath,
      cliHome,
      scratchPath,
      sourceWritable: false,
      execution,
      assertPolicy: async () => {},
    }
    completion = verifyCodexSandbox(input)
      .then(
        () => null,
        (error: unknown) => error
      )
      .finally(() => execution.cancelBeforeSpawn())
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true))
    pid = (JSON.parse(await readFile(pidFile, 'utf8')) as { pid: number }).pid
    process.kill(pid, 0)

    abort.abort()
    execution.cancelBeforeSpawn()

    expect(budget.getSnapshot().occupancy.global).toBe(1)
    expect(() =>
      budget.reserve({
        workspaceId: 'fixture',
        executionKey: 'shell:next',
        kind: 'workspace_shell',
      })
    ).toThrow('global_limit')
    const result = await completion
    pid = undefined
    expect(result).toMatchObject({ code: 'execution_cancelled' })
    expect(budget.getSnapshot().occupancy.global).toBe(0)
  } finally {
    abort.abort()
    stopFixture()
    await completion
    db.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 15_000)

test('a completed sandbox preparation returns its slot to reserved and removes probe files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hive-sandbox-completion-'))
  const db = openRuntimeDatabase()
  const budget = createResourceBudgetStore(db, { runtimeInstanceId: randomUUID() })
  budget.updateLimits({ max_running_total: 1 }, { actor: 'local_user' })
  const reservation = budget.reserve({
    workspaceId: 'fixture',
    executionKey: 'agent:probe',
    kind: 'worker',
  })
  const execution = createManagedExecution(budget, reservation)
  const workspacePath = join(root, 'workspace')
  const cliHome = join(root, 'cli-home')
  const scratchPath = join(root, 'scratch')
  const pidFile = join(root, 'probe-pid.json')
  try {
    await Promise.all([workspacePath, cliHome, scratchPath].map((path) => mkdir(path)))
    // Only the vendor sandbox result is synthetic. Process completion,
    // admission persistence, cancellation, and owned-file cleanup are real.
    await writeFile(
      join(workspacePath, 'sandbox'),
      `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({pid:process.pid}));
fs.writeFileSync(process.argv.at(-1).replace(/\\.cjs$/, '.json'), JSON.stringify({source_read:'allowed',source_write:'EPERM',outside_read:'EPERM',outside_write:'EPERM',network:'EPERM'}));`
    )
    await verifyCodexSandbox({
      executable: process.execPath,
      workspacePath,
      cliHome,
      scratchPath,
      sourceWritable: false,
      execution,
      assertPolicy: async () => {},
    })
    const { pid } = JSON.parse(await readFile(pidFile, 'utf8')) as { pid: number }
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    expect(budget.getReservation(reservation.id)).toMatchObject({
      state: 'reserved',
      pid: null,
      run_id: null,
    })
    expect(budget.getSnapshot().occupancy.global).toBe(1)
    expect(() =>
      budget.reserve({
        workspaceId: 'fixture',
        executionKey: 'shell:next',
        kind: 'workspace_shell',
      })
    ).toThrow('global_limit')
    expect(await readdir(workspacePath)).toEqual(['sandbox'])
    expect(await readdir(cliHome)).toEqual([])
    expect(await readdir(scratchPath)).toEqual([])
    execution.cancelBeforeSpawn()
    expect(budget.getSnapshot().occupancy.global).toBe(0)
  } finally {
    execution.cancelBeforeSpawn()
    db.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
