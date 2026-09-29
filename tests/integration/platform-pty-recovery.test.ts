import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { createPlatformSupervisor } from '../../scripts/platform-supervisor.mjs'

interface WorkerStart {
  pid: number
  runtime_pid: number
  previous_alive: boolean
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

test('a killed runtime releases its real PTY before the replacement starts another worker', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hive-platform-pty-recovery-'))
  const log = join(directory, 'workers.jsonl')
  const workers = (): WorkerStart[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : []
  const supervisor = createPlatformSupervisor({
    services: [
      {
        name: 'runtime',
        command: process.execPath,
        args: [
          resolve('scripts/managed-node.mjs'),
          resolve('tests/fixtures/platform-pty-service.mjs'),
        ],
        cwd: process.cwd(),
        env: { ...process.env, PLATFORM_PTY_TEST_LOG: log },
      },
    ],
    retryDelaysMs: [100],
    startupTimeoutMs: 10000,
    maxRestarts: 1,
  })
  try {
    await supervisor.start()
    const original = supervisor.getChild('runtime')
    const first = workers()[0]
    if (!original || !first) throw new Error('Expected first runtime and PTY worker')
    expect(first.pid).toBeGreaterThan(0)
    expect(first.runtime_pid).toBe(original.pid)
    expect(isAlive(first.pid)).toBe(true)
    original.kill('SIGKILL')
    await expect
      .poll(
        () => {
          const replacement = supervisor.getChild('runtime')
          return supervisor.getStatus().state === 'running' && replacement?.pid !== original.pid
        },
        { timeout: 15000 }
      )
      .toBe(true)
    const started = workers()
    expect(started).toHaveLength(2)
    const second = started[1]
    if (!second) throw new Error('Expected replacement PTY worker')
    expect(second.runtime_pid).toBe(supervisor.getChild('runtime')?.pid)
    expect(second.pid).not.toBe(first.pid)
    expect(second.previous_alive).toBe(false)
    expect(started.map(({ pid }) => isAlive(pid))).toEqual([false, true])
    expect(supervisor.getStatus().restart_count).toBe(1)
    const response = await fetch(`http://127.0.0.1:${supervisor.getPort('runtime')}/api/version`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(String(second.runtime_pid))
    await supervisor.stop()
    expect(started.map(({ pid }) => isAlive(pid))).toEqual([false, false])
  } finally {
    try {
      await supervisor.stop()
    } finally {
      for (const { pid } of workers()) {
        if (pid > 0 && isAlive(pid)) process.kill(pid, 'SIGKILL')
      }
      rmSync(directory, { recursive: true, force: true })
    }
  }
}, 40000)
