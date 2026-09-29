import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

export class PlatformRestartLimitError extends Error {
  code = 'platform_restart_limit'
  constructor(maxRestarts, cause) {
    super(`Platform restart limit (${maxRestarts}) reached: ${messageOf(cause)}`, { cause })
    this.name = 'PlatformRestartLimitError'
  }
}

const runFile = promisify(execFile)
const messageOf = (error) => (error instanceof Error ? error.message : String(error))
const waitClosed = async (record, timeoutMs) => {
  let timer
  try {
    return await Promise.race([
      record.closed.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
const stopChild = async (record, timeoutMs) => {
  if (record.hasClosed) return
  const child = record.child
  if (child.connected)
    child.send({ type: 'hive:shutdown' }, (error) => {
      if (error) record.shutdownError = error
    })
  if (await waitClosed(record, timeoutMs)) return
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    try {
      if (process.platform === 'win32')
        await runFile('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
          windowsHide: true,
        })
      else process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if (!record.hasClosed && error.code !== 'ESRCH') throw error
    }
  }
  if (!(await waitClosed(record, timeoutMs)))
    throw new Error(`Could not confirm ${record.service.name} stopped`, {
      cause: record.shutdownError,
    })
}

const ping = (record, timeoutMs, signal) =>
  new Promise((resolve, reject) => {
    const child = record.child,
      requestId = randomUUID()
    const finish = (error) => {
      clearTimeout(timer)
      child.off('message', receive)
      signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve()
    }
    const receive = (message) => {
      if (message?.type === 'hive:pong' && message.request_id === requestId) finish()
    }
    const abort = () => finish(signal.reason)
    const timer = setTimeout(
      () => finish(new Error(`${record.service.name} heartbeat timed out`)),
      timeoutMs
    )
    child.on('message', receive)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) return abort()
    if (!child.connected) return finish(new Error(`${record.service.name} IPC is disconnected`))
    child.send({ type: 'hive:ping', request_id: requestId }, (error) => {
      if (error) finish(error)
    })
  })

/** Owns only the services spawned here; every restart waits for the old group to close. */
export const createPlatformSupervisor = ({
  services,
  retryDelaysMs = [1000, 3000, 10000, 30000],
  maxRestarts = 5,
  stableAfterMs = 60000,
  startupTimeoutMs = 45000,
  healthIntervalMs = 5000,
  healthTimeoutMs = 2000,
  unhealthyThreshold = 3,
  shutdownTimeoutMs = 5000,
}) => {
  if (!services.length || new Set(services.map((service) => service.name)).size !== services.length)
    throw new Error('Supervisor requires services with unique names')
  for (const [name, value] of Object.entries({
    stableAfterMs,
    startupTimeoutMs,
    healthIntervalMs,
    healthTimeoutMs,
    shutdownTimeoutMs,
    unhealthyThreshold,
  }))
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`)
  if (
    !Number.isInteger(maxRestarts) ||
    maxRestarts < 0 ||
    !retryDelaysMs.length ||
    retryDelaysMs.some((value) => !Number.isFinite(value) || value < 0)
  )
    throw new Error('Invalid restart policy')
  const readyListeners = new Set(),
    failedListeners = new Set()
  let state = 'stopped',
    restartCount = 0,
    lastError = null,
    lastFailure
  let records = [],
    desired = false,
    lifecycle,
    startup,
    stopController,
    activeController
  let resolveStartup, rejectStartup
  const getStatus = () => ({
    state,
    restart_count: restartCount,
    last_error: lastError,
    children: records
      .filter((record) => !record.hasClosed)
      .map((record) => ({ name: record.service.name, pid: record.child.pid ?? null })),
  })
  const notify = (listeners) => {
    for (const listener of listeners) {
      try {
        listener(getStatus())
      } catch (error) {
        console.error('[HiveTeam] Supervisor listener failed:', error)
      }
    }
  }
  const spawnGroup = (controller) => {
    records = []
    for (const service of services) {
      const child = spawn(service.command, service.args, {
        cwd: service.cwd,
        env: service.env,
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        windowsHide: true,
        // Windows otherwise kills non-detached children before IPC disconnect can flush state.
        detached: true,
      })
      const record = { service, child, port: null, hasClosed: false, closed: null }
      record.closed = new Promise((resolve) =>
        child.once('close', () => {
          record.hasClosed = true
          resolve()
        })
      )
      records.push(record)
      child.once('error', (error) =>
        controller.abort(
          new Error(`${service.name} could not start: ${error.message}`, { cause: error })
        )
      )
      child.once('exit', (code, signal) =>
        controller.abort(new Error(`${service.name} exited with ${signal ?? `code ${code}`}`))
      )
      child.once('disconnect', () =>
        controller.abort(new Error(`${service.name} IPC disconnected`))
      )
      child.on('message', (message) => {
        if (
          message?.type === 'hive:runtime-ready' &&
          Number.isInteger(message.port) &&
          message.port > 0 &&
          message.port <= 65535
        )
          record.port = message.port
      })
    }
  }
  const checkService = async (record, signal, initial = false) => {
    if (initial && !record.service.readyUrl && !record.port)
      throw new Error(`${record.service.name} is not ready`)
    await ping(record, healthTimeoutMs, signal)
    const readyUrl =
      record.service.readyUrl ??
      (record.port ? `http://127.0.0.1:${record.port}/api/version` : null)
    if (readyUrl) {
      const response = await fetch(readyUrl, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(healthTimeoutMs)]),
        redirect: 'error',
      })
      await response.body?.cancel()
      if (!response.ok)
        throw new Error(`${record.service.name} health returned HTTP ${response.status}`)
    }
  }
  const waitReady = async (signal) => {
    const readiness = AbortSignal.any([signal, AbortSignal.timeout(startupTimeoutMs)])
    let failure
    try {
      while (true) {
        readiness.throwIfAborted()
        try {
          await Promise.all(records.map((record) => checkService(record, readiness, true)))
          return
        } catch (error) {
          failure = error
          readiness.throwIfAborted()
        }
        await delay(100, undefined, { signal: readiness })
      }
    } catch (error) {
      signal.throwIfAborted()
      throw new Error(`Services did not become ready: ${messageOf(failure ?? error)}`, {
        cause: failure ?? error,
      })
    }
  }
  const monitor = async (signal) => {
    let failures = 0
    while (true) {
      await delay(healthIntervalMs, undefined, { signal })
      try {
        await Promise.all(records.map((record) => checkService(record, signal)))
        failures = 0
      } catch (error) {
        signal.throwIfAborted()
        if (++failures >= unhealthyThreshold) throw error
      }
    }
  }
  const closeGroup = async () => {
    const results = await Promise.allSettled(
      records.map((record) => stopChild(record, shutdownTimeoutMs))
    )
    const failures = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason)
    if (failures.length)
      throw new AggregateError(
        failures,
        `Service cleanup failed: ${failures.map(messageOf).join('; ')}`
      )
    records = []
  }
  const run = async () => {
    try {
      while (desired) {
        activeController = new AbortController()
        let stableTimer
        try {
          spawnGroup(activeController)
          await waitReady(activeController.signal)
          activeController.signal.throwIfAborted()
          state = 'running'
          lastError = null
          resolveStartup()
          notify(readyListeners)
          stableTimer = setTimeout(() => {
            restartCount = 0
          }, stableAfterMs)
          await monitor(activeController.signal)
        } catch (error) {
          if (desired) {
            lastFailure = activeController.signal.reason ?? error
            lastError = messageOf(lastFailure)
            state = 'restarting'
          }
        } finally {
          clearTimeout(stableTimer)
          activeController.abort(new Error('Service group is stopping'))
          await closeGroup()
        }
        if (!desired) break
        if (restartCount >= maxRestarts)
          throw new PlatformRestartLimitError(maxRestarts, lastFailure)
        state = 'restarting'
        const waitMs = retryDelaysMs[Math.min(restartCount, retryDelaysMs.length - 1)]
        restartCount++
        await delay(waitMs, undefined, { signal: stopController.signal })
      }
    } catch (error) {
      if (desired || records.some((record) => !record.hasClosed)) {
        state = 'failed'
        lastError = messageOf(error)
        rejectStartup(error)
        notify(failedListeners)
      }
    } finally {
      desired = false
      activeController = undefined
      if (state !== 'failed') state = 'stopped'
      rejectStartup(new Error('Platform stopped before becoming ready'))
    }
  }
  return {
    start() {
      if (desired) return startup
      if (lifecycle && state !== 'stopped' && state !== 'failed')
        return Promise.reject(new Error('Platform is still stopping'))
      if (records.some((record) => !record.hasClosed))
        return Promise.reject(new Error('Previous services have not stopped'))
      desired = true
      state = 'starting'
      restartCount = 0
      lastError = null
      stopController = new AbortController()
      startup = new Promise((resolve, reject) => {
        resolveStartup = resolve
        rejectStartup = reject
      })
      lifecycle = run()
      return startup
    },
    async stop() {
      if (!lifecycle) return
      desired = false
      if (state !== 'stopped') state = 'stopping'
      stopController.abort()
      activeController?.abort(new Error('Platform stopped by user'))
      await lifecycle
      if (records.some((record) => !record.hasClosed)) await closeGroup()
      state = 'stopped'
    },
    getChild(name) {
      return records.find((record) => record.service.name === name && !record.hasClosed)?.child
    },
    getPort(name) {
      return (
        records.find((record) => record.service.name === name && !record.hasClosed)?.port ?? null
      )
    },
    getStatus,
    onReady(callback) {
      readyListeners.add(callback)
      return () => readyListeners.delete(callback)
    },
    onFailed(callback) {
      failedListeners.add(callback)
      return () => failedListeners.delete(callback)
    },
  }
}
