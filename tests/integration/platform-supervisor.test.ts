import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createPlatformSupervisor } from '../../scripts/platform-supervisor.mjs'
import { requestUiBootstrap } from '../../scripts/ui-launcher.mjs'

const supervisors: ReturnType<typeof createPlatformSupervisor>[] = []
const directories: string[] = []
const parents: ChildProcess[] = []
const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error('Expected supervisor test value')
  return value
}
const service = (name: string, env: NodeJS.ProcessEnv = {}) => ({
  name,
  command: process.execPath,
  args: [resolve('scripts/managed-node.mjs'), resolve('tests/fixtures/platform-service.mjs')],
  cwd: process.cwd(),
  env: { ...process.env, ...env },
})
const create = (options: Parameters<typeof createPlatformSupervisor>[0]) => {
  const supervisor = createPlatformSupervisor({
    retryDelaysMs: [30],
    startupTimeoutMs: 5000,
    healthIntervalMs: 100,
    healthTimeoutMs: 1000,
    shutdownTimeoutMs: 500,
    ...options,
  })
  supervisors.push(supervisor)
  return supervisor
}
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}
afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) await supervisor.stop()
  for (const parent of parents.splice(0)) {
    if (parent.exitCode !== null || parent.signalCode !== null) continue
    const closed = once(parent, 'close')
    const fallback = setTimeout(() => parent.kill('SIGKILL'), 2000)
    parent.send({ type: 'fixture:stop-parent' })
    await closed
    clearTimeout(fallback)
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test('starts real services, routes bootstrap to the current child, and stops through graceful IPC', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hive-supervisor-'))
  directories.push(directory)
  const log = join(directory, 'events.jsonl')
  const supervisor = create({
    services: [service('runtime', { SUPERVISOR_TEST_LOG: log }), service('web')],
  })
  await supervisor.start()
  expect(supervisor.getStatus()).toMatchObject({
    state: 'running',
    restart_count: 0,
    last_error: null,
  })
  const port = supervisor.getPort('runtime')
  expect(port).toBeGreaterThan(0)
  expect((await fetch(`http://127.0.0.1:${port}/api/version`)).status).toBe(200)
  const child = required(supervisor.getChild('runtime'))
  expect(await requestUiBootstrap(child)).toBe(String(child.pid))
  const pids = supervisor.getStatus().children.map((item) => required(item.pid))
  expect(pids).toHaveLength(2)
  await supervisor.stop()
  expect(supervisor.getStatus().state).toBe('stopped')
  expect(pids.map(isAlive)).toEqual([false, false])
  expect(readFileSync(log, 'utf8')).toContain('"event":"shutdown"')
})

test('restarts the whole group only after old children exit and authenticates against the replacement', async () => {
  const supervisor = create({ services: [service('runtime'), service('web')] })
  const observed: Array<{ pid: number | null; previousAlive: boolean[] }> = []
  let previous: number[] = []
  supervisor.onReady((status) =>
    observed.push({ pid: required(status.children[0]).pid, previousAlive: previous.map(isAlive) })
  )
  await supervisor.start()
  previous = supervisor.getStatus().children.map((item) => required(item.pid))
  const oldRuntime = required(supervisor.getChild('runtime'))
  oldRuntime.send({ type: 'fixture:crash' })
  await expect.poll(() => observed.length, { timeout: 7000 }).toBe(2)
  expect(required(observed[1]).previousAlive).toEqual([false, false])
  const current = required(supervisor.getChild('runtime'))
  expect(current.pid).not.toBe(oldRuntime.pid)
  expect(await requestUiBootstrap(current)).toBe(String(current.pid))
  expect(supervisor.getStatus()).toMatchObject({ state: 'running', restart_count: 1 })
})

test.each([
  'fixture:hang',
  'fixture:unhealthy',
])('replaces an unresponsive or unhealthy real service (%s)', async (type) => {
  const supervisor = create({
    services: [service('runtime'), service('web')],
    healthTimeoutMs: 150,
    unhealthyThreshold: 1,
  })
  await supervisor.start()
  const old = supervisor.getStatus().children.map((item) => required(item.pid))
  required(supervisor.getChild('runtime')).send({ type })
  await expect
    .poll(
      () => {
        const status = supervisor.getStatus()
        return status.state === 'running' && status.restart_count === 1
      },
      { timeout: 7000 }
    )
    .toBe(true)
  expect(old.map(isAlive)).toEqual([false, false])
  expect(await requestUiBootstrap(required(supervisor.getChild('runtime')))).toBe(
    String(required(supervisor.getChild('runtime')).pid)
  )
})

test('stops during startup and cancels a scheduled restart without resurrecting services', async () => {
  const starting = create({ services: [service('runtime', { SUPERVISOR_TEST_NEVER_READY: '1' })] })
  const result = starting.start().then(
    () => 'ready',
    (error: Error) => error.message
  )
  const pendingPid = required(required(starting.getChild('runtime')).pid)
  await starting.stop()
  expect(await result).toContain('stopped before becoming ready')
  expect(starting.getStatus().state).toBe('stopped')
  expect(isAlive(pendingPid)).toBe(false)

  const restarting = create({ services: [service('runtime')], retryDelaysMs: [500] })
  let readyCount = 0
  restarting.onReady(() => {
    readyCount++
  })
  await restarting.start()
  required(restarting.getChild('runtime')).send({ type: 'fixture:crash' })
  await expect.poll(() => restarting.getStatus().state).toBe('restarting')
  await restarting.stop()
  await new Promise((resolve) => setTimeout(resolve, 600))
  expect(restarting.getStatus()).toMatchObject({ state: 'stopped', children: [] })
  expect(readyCount).toBe(1)
})

test('bounds consecutive startup failures, reports failure, and retains no child processes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hive-supervisor-failures-'))
  directories.push(directory)
  const log = join(directory, 'events.jsonl')
  const supervisor = create({
    services: [
      service('runtime', { SUPERVISOR_TEST_EXIT_ON_START: '1', SUPERVISOR_TEST_LOG: log }),
    ],
    maxRestarts: 2,
  })
  let failure: ReturnType<typeof supervisor.getStatus> | undefined
  supervisor.onFailed((status) => {
    failure = status
  })
  const failureError = await supervisor.start().catch((error: unknown) => error)
  expect(failureError).toMatchObject({ code: 'platform_restart_limit', cause: expect.any(Error) })
  expect(supervisor.getStatus()).toMatchObject({ state: 'failed', restart_count: 2, children: [] })
  expect(failure?.state).toBe('failed')
  const events: Array<{ pid: number }> = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(events).toHaveLength(3)
  expect(events.map((event) => isAlive(event.pid))).toEqual([false, false, false])
})

test('reports real spawn failure and permits another explicit start after a completed stop', async () => {
  const missing = create({
    services: [{ ...service('missing'), command: `${process.execPath}.not-installed` }],
    maxRestarts: 1,
  })
  await expect(missing.start()).rejects.toThrow('ENOENT')
  expect(missing.getStatus()).toMatchObject({ state: 'failed', restart_count: 1, children: [] })
  const supervisor = create({ services: [service('runtime')] })
  await supervisor.start()
  const oldPid = required(required(supervisor.getChild('runtime')).pid)
  await supervisor.stop()
  await supervisor.start()
  expect(supervisor.getStatus().state).toBe('running')
  expect(required(supervisor.getChild('runtime')).pid).not.toBe(oldPid)
  expect(isAlive(oldPid)).toBe(false)
})

test('resets the retry budget only after a stable running period', async () => {
  const supervisor = create({ services: [service('runtime')], maxRestarts: 1, stableAfterMs: 500 })
  await supervisor.start()
  required(supervisor.getChild('runtime')).send({ type: 'fixture:crash' })
  await expect
    .poll(
      () =>
        supervisor.getStatus().state === 'running' && supervisor.getStatus().restart_count === 1,
      { timeout: 5000 }
    )
    .toBe(true)
  await expect.poll(() => supervisor.getStatus().restart_count).toBe(0)
  const previous = required(required(supervisor.getChild('runtime')).pid)
  required(supervisor.getChild('runtime')).send({ type: 'fixture:crash' })
  await expect
    .poll(
      () =>
        supervisor.getStatus().state === 'running' &&
        supervisor.getChild('runtime')?.pid !== previous,
      { timeout: 5000 }
    )
    .toBe(true)
  expect(supervisor.getStatus().restart_count).toBe(1)
})

test('uses an explicit HTTP readiness URL for a service without a runtime-ready message', async () => {
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP address')
  const port = address.port
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve()))
  )
  const supervisor = create({
    services: [
      {
        ...service('web', { SUPERVISOR_TEST_PORT: String(port), SUPERVISOR_TEST_NEVER_READY: '1' }),
        readyUrl: `http://127.0.0.1:${port}/`,
      },
    ],
    unhealthyThreshold: 1,
  })
  await supervisor.start()
  expect(supervisor.getStatus().state).toBe('running')
  expect(supervisor.getPort('web')).toBeNull()
  const pid = required(required(supervisor.getChild('web')).pid)
  expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe(String(pid))
  required(supervisor.getChild('web')).send({ type: 'fixture:unhealthy' })
  await expect
    .poll(
      () => supervisor.getStatus().state === 'running' && supervisor.getChild('web')?.pid !== pid,
      { timeout: 7000 }
    )
    .toBe(true)
  expect(isAlive(pid)).toBe(false)
})

test('fails bounded startup when the entry never becomes ready and stops an entry without signal handlers', async () => {
  const neverReady = create({
    services: [service('runtime', { SUPERVISOR_TEST_NEVER_READY: '1' })],
    maxRestarts: 0,
    startupTimeoutMs: 250,
  })
  await expect(neverReady.start()).rejects.toThrow('did not become ready')
  expect(neverReady.getStatus()).toMatchObject({ state: 'failed', children: [] })
  const noHandler = create({ services: [service('runtime', { SUPERVISOR_TEST_NO_HANDLER: '1' })] })
  await noHandler.start()
  const child = required(noHandler.getChild('runtime'))
  await noHandler.stop()
  expect(child.exitCode).toBe(0)
  expect(isAlive(required(child.pid))).toBe(false)
})

test('managed service cleans up through SIGTERM when its independent supervisor process crashes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hive-supervisor-parent-'))
  directories.push(directory)
  const log = join(directory, 'events.jsonl')
  const parent = spawn(
    process.execPath,
    [resolve('tests/fixtures/platform-supervisor-parent.mjs')],
    {
      env: { ...process.env, SUPERVISOR_TEST_LOG: log },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      windowsHide: true,
    }
  )
  parents.push(parent)
  const [message] = await once(parent, 'message')
  expect(message.type).toBe('fixture:parent-ready')
  expect(isAlive(message.pid)).toBe(true)
  const closed = once(parent, 'close')
  parent.send({ type: 'fixture:crash-parent' })
  await closed
  expect(parent.exitCode).toBe(42)
  await expect.poll(() => isAlive(message.pid), { timeout: 7000 }).toBe(false)
  expect(readFileSync(log, 'utf8')).toContain('"event":"shutdown"')
})

test('the startup deadline cancels an in-flight HTTP probe even with a longer health timeout', async () => {
  const supervisor = create({
    services: [service('runtime', { SUPERVISOR_TEST_HANG_HTTP: '1' })],
    maxRestarts: 0,
    startupTimeoutMs: 200,
    healthTimeoutMs: 5000,
  })
  const startedAt = Date.now()
  await expect(supervisor.start()).rejects.toThrow('did not become ready')
  expect(Date.now() - startedAt).toBeLessThan(2000)
  expect(supervisor.getStatus()).toMatchObject({ state: 'failed', children: [] })
})
