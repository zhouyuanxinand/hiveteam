import { execFileSync } from 'node:child_process'

import type { IPty } from 'node-pty'

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
  const isAlreadyKilledPtyError = (error: unknown) =>
    process.platform === 'win32' &&
    /pty seems to have been killed already|pty is not active|already exited/i.test(
      error instanceof Error ? error.message : String(error)
    )
  const ptyErrorEmitter = pty as IPty & {
    on?: (event: 'error', listener: (error: unknown) => void) => unknown
  }
  const ptyInputSocket = (
    pty as unknown as {
      _agent?: {
        inSocket?: {
          on?: (event: 'error', listener: (error: unknown) => void) => unknown
        }
      }
    }
  )._agent?.inSocket
  if (process.platform === 'win32' && typeof ptyErrorEmitter.on === 'function') {
    // node-pty's WindowsTerminal throws from its internal socket error
    // handler unless the terminal has at least two error listeners. A PTY
    // that Hive has just stopped can report this asynchronously, after the
    // synchronous kill() call has already returned. Consume that benign
    // teardown error so it cannot become an uncaught exception.
    ptyErrorEmitter.on('error', (error) => {
      if (!isAlreadyKilledPtyError(error)) {
        console.warn('[hive] PTY error during Windows terminal teardown', {
          error: error instanceof Error ? error.message : String(error),
          runId: run.runId,
        })
      }
    })
    ptyErrorEmitter.on('error', () => {})
  }
  if (process.platform === 'win32' && typeof ptyInputSocket?.on === 'function') {
    // Windows node-pty writes through a private input net.Socket. A write
    // that was queued just before the child exits can complete after the
    // socket is closed and emit `write EOF` on that socket rather than on the
    // public IPty event emitter. Always consume the expected teardown error so
    // it cannot surface as an uncaught exception; unexpected errors remain
    // visible in the runtime log.
    ptyInputSocket.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error)
      if (!/write EOF|write EPIPE|stream was destroyed|socket is closed/i.test(message)) {
        console.warn('[hive] PTY input socket error', { error: message, runId: run.runId })
      }
    })
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
  const isWindowsPtyReady = () => (pty as IPty & { _isReady?: boolean })._isReady !== false
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
        // node-pty queues kill() until the Winpty data pipe becomes ready.
        // If shutdown happens before that point, a naturally closing child can
        // make the deferred kill throw asynchronously. Terminate the concrete
        // child instead; the Winpty agent then closes its pipes normally.
        if (isWindowsPtyReady()) pty.kill()
        else terminateWindowsChild()
      } else pty.kill(signal)
    } catch (error) {
      if (!isAlreadyKilledPtyError(error)) ignoreMissingProcess(error)
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
        if (!isAlreadyKilledPtyError(error)) ignoreMissingProcess(error)
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
    pid: pty.pid,
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
      if (
        process.platform === 'win32' &&
        process.env.HIVE_TEST_PTY_BACKEND === 'winpty' &&
        typeof text === 'string' &&
        text.endsWith('\n') &&
        !text.endsWith('\r\n')
      ) {
        // Winpty exposes a Windows console input buffer: a bare LF is not
        // treated as Enter by line-oriented child CLIs. Keep production input
        // byte-for-byte intact and only normalize the test backend's final
        // line terminator.
        pty.write(`${text.slice(0, -1)}\r\n`)
        return
      }
      pty.write(text)
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
    // Winpty may report null or a forced-termination code when Hive closes a
    // healthy agent. An explicit Hive stop is a clean lifecycle transition;
    // only spontaneous non-zero exits should mark the run as failed.
    finishAgentRun(run, stopRequested ? 0 : event.exitCode, ptyOutputBus)
  })
}
