import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, test } from 'vitest'
import { createAgentManager } from '../../src/server/agent-manager.js'
import { createManagedExecution } from '../../src/server/managed-execution.js'
import { createResourceBudgetStore } from '../../src/server/resource-budget-store.js'
import { openRuntimeDatabase } from '../../src/server/runtime-database.js'
import { normalizePtyText } from '../helpers/platform-cli.js'
import { startAuthorizedTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const cleanups: Array<() => Promise<void>> = []
const executeFile = promisify(execFile)
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const createFixture = () => {
  const directory = mkdtempSync(join(tmpdir(), 'hive-native-PTY 中文 '))
  const db = openRuntimeDatabase(directory)
  const resources = createResourceBudgetStore(db, { runtimeInstanceId: randomUUID() })
  const manager = createAgentManager()
  const runIds: string[] = []
  cleanups.push(async () => {
    for (const runId of runIds) {
      manager.stopRun(runId)
      await manager.waitForRunExit?.(runId)
    }
    db.close()
    rmSync(directory, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 })
  })
  const start = async (source: string, signal?: AbortSignal) => {
    const id = randomUUID()
    const script = join(directory, `${id}.cjs`)
    writeFileSync(script, source)
    const reservation = resources.reserve({
      workspaceId: 'native-fixture',
      executionKey: `agent:${id}`,
      agentId: id,
      kind: 'worker',
    })
    const run = await manager.startAgent({
      agentId: id,
      command: process.execPath,
      args: [script],
      cwd: directory,
      execution: createManagedExecution(resources, reservation, signal),
    })
    runIds.push(run.runId)
    return { run, reservation }
  }
  return { manager, resources, start }
}

test('connects a silent child using its real PID and releases it after repeated stop', async () => {
  const { manager, resources, start } = createFixture()
  const { run, reservation } = await start('setInterval(() => {}, 1000)')
  expect(run.pid).toBeGreaterThan(0)
  expect(resources.getReservation(reservation.id)).toMatchObject({ state: 'running', pid: run.pid })
  // No application output is required to finish startAgent.
  expect(['starting', 'running']).toContain(run.status)
  manager.stopRun(run.runId)
  manager.stopRun(run.runId)
  await manager.waitForRunExit?.(run.runId)
  expect(manager.getRun(run.runId)).toMatchObject({ status: 'exited', exitCode: 0 })
  expect(resources.getReservation(reservation.id)).toMatchObject({
    state: 'released',
    reason: 'exit_confirmed',
  })
  expect(resources.getSnapshot().occupancy.global).toBe(0)
})

test.each([
  0, 7,
])('records immediate native exit %i without losing its PID or reservation', async (exitCode) => {
  const { manager, resources, start } = createFixture()
  const { run, reservation } = await start(`process.exit(${exitCode})`)
  await manager.waitForRunExit?.(run.runId)
  expect(run.pid).toBeGreaterThan(0)
  expect(manager.getRun(run.runId)).toMatchObject({
    status: exitCode === 0 ? 'exited' : 'error',
    exitCode,
  })
  expect(resources.getReservation(reservation.id)).toMatchObject({
    state: 'released',
    pid: run.pid,
  })
  manager.resizeRun(run.runId, 100, 30)
  expect(manager.getTerminalSize(run.runId)).toEqual({ cols: 80, rows: 24 })
})

test.each([0, 7])('lets its Node host exit naturally after native exit %i', async (exitCode) => {
  const directory = mkdtempSync(join(tmpdir(), 'hive-native-host 中文 '))
  cleanups.push(async () =>
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  )
  const { stdout } = await executeFile(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('../fixtures/pty-natural-exit.ts', import.meta.url)),
      directory,
      String(exitCode),
    ],
    { timeout: 15_000, windowsHide: true }
  )
  expect(JSON.parse(stdout)).toMatchObject({
    run: { status: exitCode === 0 ? 'exited' : 'error', exitCode },
    occupancy: 0,
  })
})

test('stops an execution aborted while its native connection is pending', async () => {
  const { manager, resources, start } = createFixture()
  const controller = new AbortController()
  const starting = start('setInterval(() => {}, 1000)', controller.signal)
  controller.abort()
  const { run } = await starting
  await manager.waitForRunExit?.(run.runId)
  expect(manager.getRun(run.runId)).toMatchObject({ status: 'exited', exitCode: 0 })
  expect(resources.getSnapshot().occupancy.global).toBe(0)
})

test('queues input sent at PID readiness before the child has printed or completed terminal negotiation', async () => {
  const { manager, start } = createFixture()
  const marker = `early-${randomUUID()}`
  const { run } = await start(`
process.stdin.setEncoding('utf8')
let input = ''
process.stdin.on('data', (chunk) => {
  input += chunk
  if (input.includes(${JSON.stringify(marker)})) {
    process.stdout.write('RECEIVED:' + ${JSON.stringify(marker)} + '\\r\\n')
    process.exit(0)
  }
})
`)
  manager.writeInput(run.runId, `${marker}\r`)
  await expect.poll(() => manager.getRun(run.runId).status, { timeout: 7000 }).toBe('exited')
  await manager.waitForRunExit?.(run.runId)
  expect(normalizePtyText(manager.getRun(run.runId).output)).toContain(`RECEIVED:${marker}`)
  expect(manager.getRun(run.runId).exitCode).toBe(0)
})

test('delivers Unicode input and changes the actual native terminal geometry', async () => {
  const { manager, start } = createFixture()
  const { run } = await start(`
const { WriteStream } = require('node:tty')
process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
let input = ''
process.stdin.on('data', (text) => {
  input += text
  let end
  while ((end = input.indexOf('\\r')) !== -1) {
    const line = input.slice(0, end)
    input = input.slice(end + 1)
    if (line === 'SIZE') {
      const terminal = new WriteStream(process.stdout.fd)
      const size = terminal.getWindowSize()
      terminal.destroy()
      process.stdout.write('SIZE:' + size.join('x') + '\\r\\n')
    } else process.stdout.write('ECHO:' + line + '\\r\\n')
  }
})
process.stdout.write('READY\\r\\n')
`)
  await expect
    .poll(() => normalizePtyText(manager.getRun(run.runId).output), { timeout: 5000 })
    .toContain('READY')
  manager.writeInput(run.runId, '你好 native terminal\r')
  await expect
    .poll(() => normalizePtyText(manager.getRun(run.runId).output))
    .toContain('ECHO:你好 native terminal')
  for (const [cols, rows] of [
    [101, 31],
    [113, 37],
  ] as const) {
    manager.resizeRun(run.runId, cols, rows)
    manager.writeInput(run.runId, 'SIZE\r')
    await expect
      .poll(() => normalizePtyText(manager.getRun(run.runId).output), { timeout: 5000 })
      .toContain(`SIZE:${cols}x${rows}`)
  }
})

test('survives input racing native EOF while preserving worker pending work and releasing capacity', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hive-native-race 中文 '))
  const workspacePath = join(directory, 'workspace with spaces')
  mkdirSync(workspacePath)
  const script = join(directory, 'exit-on-input.cjs')
  writeFileSync(
    script,
    `
process.stdin.setRawMode(true)
let input = ''
process.stdin.on('data', (chunk) => {
  input += chunk.toString()
  if (input.includes('EXIT')) process.exit(7)
})
process.stdout.write('READY\\r\\n')
`
  )
  const server = await startAuthorizedTestServer({ dataDir: directory })
  cleanups.push(async () => {
    await server.close()
    rmSync(directory, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 })
  })
  const workspace = server.store.createWorkspace(workspacePath, 'Native race')
  const worker = server.store.addWorker(workspace.id, { name: 'Race', role: 'coder' })
  server.store.configureAgentLaunch(workspace.id, worker.id, {
    command: process.execPath,
    args: [script],
  })
  const cookie = await getUiCookie(server.baseUrl)
  const startResponse = await fetch(
    `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`,
    {
      method: 'POST',
      headers: { cookie },
    }
  )
  expect(startResponse.status).toBe(201)
  const { run_id: runId } = (await startResponse.json()) as { run_id: string }
  await expect
    .poll(() => normalizePtyText(server.store.getLiveRun(runId).output), { timeout: 5000 })
    .toContain('READY')
  const dispatch = await server.store.dispatchTask(
    workspace.id,
    worker.id,
    'Keep this unfinished task'
  )
  expect(['queued', 'submitted']).toContain(dispatch.status)
  server.store.writeRunInput(runId, 'EXIT\r')
  // Continue writing while Windows still drains native output and has not yet
  // emitted onExit. This reproduces its real asynchronous input-socket race.
  for (let index = 0; index < 1000; index += 1) {
    const status = server.store.getLiveRun(runId).status
    if (status === 'exited' || status === 'error') break
    try {
      server.store.writeRunInput(runId, 'racing input\r')
    } catch {
      // Input failure must become a failed run below, never a successful task.
      break
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
  await expect.poll(() => server.store.getLiveRun(runId).status, { timeout: 5000 }).toBe('error')
  expect(server.store.getLiveRun(runId).exitCode).not.toBe(0)
  expect(server.store.listWorkers(workspace.id)).toContainEqual(
    expect.objectContaining({
      id: worker.id,
      status: 'stopped',
      pendingTaskCount: 1,
    })
  )
  const pending = server.store.listDispatches(workspace.id).find((item) => item.id === dispatch.id)
  expect(pending).toMatchObject({ text: 'Keep this unfinished task', reportedAt: null })
  expect(['queued', 'submitted']).toContain(pending?.status)
  await expect
    .poll(() => server.store.resources.getSnapshot().occupancy.global, { timeout: 5000 })
    .toBe(0)
  const response = await fetch(`${server.baseUrl}/api/runtime/runs/${runId}`, {
    headers: { cookie },
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ status: 'error', runId })
})
