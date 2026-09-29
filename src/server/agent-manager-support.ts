import { execFileSync } from 'node:child_process'

import type { IPty } from '@lydell/node-pty'

import type { AgentRunRecord, AgentRunSnapshot } from './agent-manager.js'
import type { PtyOutputBus } from './pty-output-bus.js'

export const MAX_RUN_OUTPUT_LENGTH = 1_000_000
const FORCE_KILL_DELAY_MS = 750

export const toAgentRunSnapshot = (run: AgentRunRecord): AgentRunSnapshot => ({
  runId: run.runId,
  agentId: run.agentId,
  pid: run.process.pid,
  status:
    run.process.isStopped() && run.status !== 'exited' && run.status !== 'error'
      ? 'error'
      : run.status,
  output: run.output,
  exitCode: run.exitCode,
})

export const finishAgentRun = (
  run: AgentRunRecord,
  exitCode: number | null,
  ptyOutputBus: PtyOutputBus
) => {
  if (run.status === 'exited' || run.status === 'error') return
  run.status = exitCode === 0 ? 'exited' : 'error'
  run.exitCode = exitCode
  run.onExit?.({ runId: run.runId, exitCode })
  // Let stream subscribers react to the exit synchronously instead of polling
  // the run status on an interval.
  ptyOutputBus.publishExit(run.runId)
  ptyOutputBus.clear(run.runId)
}

export const attachAgentPty = (run: AgentRunRecord, pty: IPty, ptyOutputBus: PtyOutputBus) => {
  let stdinClosed = false
  let stopRequested = false
  let ioFailed = false
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined
  const resolveProcessGroupId = () => {
    if (process.platform === 'win32' || pty.pid <= 0) return null
    try {
      const value = execFileSync('ps', ['-o', 'pgid=', '-p', String(pty.pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      const groupId = Number(value)
      if (Number.isInteger(groupId) && groupId > 0) return groupId
    } catch {
      return pty.pid
    }
    return pty.pid
  }
  const processGroupId = resolveProcessGroupId()
  const stopped = () => run.status === 'exited' || run.status === 'error'
  const ptyErrorEmitter = pty as IPty & {
    on?: (event: 'error', listener: (error: unknown) => void) => unknown
  }
  const windowsAgent = (
    pty as unknown as {
      _agent?: {
        inSocket?: {
          on?: (event: 'error', listener: (error: unknown) => void) => unknown
        }
        _conoutSocketWorker?: { dispose: () => void }
      }
    }
  )._agent
  const handleIoError = (error: unknown) => {
    stdinClosed = true
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (
      (stopRequested || stopped()) &&
      code &&
      ['EOF', 'EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED', 'EBADF'].includes(code)
    )
      return
    ioFailed = true
    console.error('[hive] PTY I/O failed', { error, runId: run.runId, pid: pty.pid })
    if (!stopped()) run.process.stop()
  }
  if (process.platform === 'win32') {
    // The terminal's legacy error event forwards its output socket. Its own
    // socket listener counts toward the two listeners required by node-pty.
    ptyErrorEmitter.on?.('error', handleIoError)
    // Input errors are not forwarded by node-pty. Keep this narrow adaptation
    // until it exposes them publicly; a queued write can fail after native EOF.
    windowsAgent?.inSocket?.on?.('error', handleIoError)
  }
  const ignoreMissingProcess = (error: unknown) => {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ESRCH') throw error
  }
  const ignoreBestEffortGroupKillError = (error: unknown) => {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code !== 'ESRCH' && code !== 'EPERM') throw error
  }
  const terminateWindowsChild = () => {
    if (process.platform !== 'win32' || pty.pid <= 0) return
    try {
      process.kill(pty.pid, 'SIGKILL')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code !== 'ESRCH' && code !== 'EPERM') throw error
    }
  }
  const killProcessGroup = (signal: NodeJS.Signals) => {
    if (process.platform === 'win32' || processGroupId === null) return
    try {
      process.kill(-processGroupId, signal)
    } catch (error) {
      ignoreBestEffortGroupKillError(error)
    }
  }
  const killPty = (signal: NodeJS.Signals) => {
    try {
      if (process.platform === 'win32') {
        pty.kill()
      } else pty.kill(signal)
    } catch (error) {
      ignoreMissingProcess(error)
    }
    killProcessGroup(signal)
  }
  const clearForceKillTimer = () => {
    if (!forceKillTimer) return
    clearTimeout(forceKillTimer)
    forceKillTimer = undefined
  }
  const cleanupProcessGroup = () => {
    clearForceKillTimer()
    killProcessGroup('SIGKILL')
  }
  const scheduleForceKill = () => {
    if (forceKillTimer) return
    forceKillTimer = setTimeout(() => {
      forceKillTimer = undefined
      try {
        // Never enqueue a second Windows pty.kill(). The first call may still
        // be deferred inside node-pty and duplicate deferred kills produce
        // "Pty seems to have been killed already" as an uncaught exception.
        if (process.platform === 'win32') terminateWindowsChild()
        else pty.kill('SIGKILL')
      } catch (error) {
        ignoreMissingProcess(error)
      }
      killProcessGroup('SIGKILL')
    }, FORCE_KILL_DELAY_MS)
    forceKillTimer.unref?.()
  }
  run.process = {
    isStopped() {
      return stopped()
    },
    pause() {
      pty.pause()
    },
    get pid() {
      return pty.pid > 0 ? pty.pid : null
    },
    resize(cols, rows) {
      pty.resize(cols, rows)
    },
    resume() {
      pty.resume()
    },
    stop() {
      if (stopped()) {
        cleanupProcessGroup()
        return
      }
      // Stop can be requested from more than one lifecycle path (for example
      // worker deletion and runtime shutdown racing each other). node-pty's
      // Windows backend reports a second kill asynchronously as an uncaught
      // "Pty seems to have been killed already" error, so make the operation
      // idempotent while the first stop is still being torn down.
      if (stopRequested) return
      stopRequested = true
      killPty('SIGTERM')
      stdinClosed = true
      scheduleForceKill()
    },
    write(text) {
      if (stdinClosed || run.status === 'exited' || run.status === 'error') {
        throw new Error(`PTY is not active for run: ${run.runId}`)
      }
      try {
        pty.write(text)
      } catch (error) {
        handleIoError(error)
        throw error
      }
    },
  }

  pty.onData((chunk) => {
    if (run.status === 'starting') run.status = 'running'
    run.output += chunk
    if (run.output.length > MAX_RUN_OUTPUT_LENGTH)
      run.output = run.output.slice(-MAX_RUN_OUTPUT_LENGTH)
    ptyOutputBus.publish(run.runId, chunk)
  })

  pty.onExit((event) => {
    stdinClosed = true
    cleanupProcessGroup()
    if (process.platform === 'win32') {
      // @lydell/node-pty 1.2.0-beta.15: DLL natural EOF leaves its forwarding
      // worker's server listening. kill() releases native/input handles, but
      // its worker cleanup waits for future data which EOF cannot provide.
      // onExit follows output-pipe close, so all output is already drained.
      if (!stopRequested && pty.pid > 0) pty.kill()
      windowsAgent?._conoutSocketWorker?.dispose()
    }
    // The native PTY may report a forced-termination code when Hive closes a
    // healthy agent. An explicit Hive stop is a clean lifecycle transition;
    // only spontaneous non-zero exits should mark the run as failed.
    finishAgentRun(run, ioFailed ? 1 : stopRequested ? 0 : event.exitCode, ptyOutputBus)
  })
}
