import { randomUUID } from 'node:crypto'
import { type IPty, spawn } from 'node-pty'
import { resolveSpawnCommand } from './agent-command-resolver.js'
import { attachAgentPty, toAgentRunSnapshot } from './agent-manager-support.js'
import { createExecutionEnvironment } from './execution-environment.js'
import type { ManagedExecution } from './managed-execution.js'
import { withoutManagementCredentials } from './management-environment.js'
import { createPtyOutputBus, type PtyOutputBus } from './pty-output-bus.js'
import { executeRemoteInput } from './remote-action-context.js'
import { ResourceReservationError } from './resource-budget-store.js'
import { isTerminalReplyOnly } from './terminal-input-classification.js'
import { TerminalStateMirror } from './terminal-state-mirror.js'

type RunStatus = 'starting' | 'running' | 'exited' | 'error'

interface StartAgentInput {
  afterNativeExit?: () => Promise<void>
  execution: ManagedExecution
  agentId: string
  command: string
  args?: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  onExit?: (event: { runId: string; exitCode: number | null }) => void
}

interface AgentRunSnapshot {
  runId: string
  agentId: string
  pid: number | null
  status: RunStatus
  output: string
  exitCode: number | null
}

interface AgentRunRecord extends AgentRunSnapshot {
  inputSequence: number
  terminalSize: { cols: number; rows: number }
  process: {
    isStopped: () => boolean
    pause: () => void
    pid: number | null
    resize: (cols: number, rows: number) => void
    resume: () => void
    stop: () => void
    write: (input: Buffer | string) => void
  }
  onExit?: (event: { runId: string; exitCode: number | null }) => void
}

interface AgentManager {
  getTerminalScreen: (runId: string) => Promise<string>
  getInputSequence: (runId: string) => number
  getTerminalSize: (runId: string) => { cols: number; rows: number }
  getOutputBus: () => PtyOutputBus
  pauseRun: (runId: string) => void
  resizeRun: (runId: string, cols: number, rows: number) => void
  resumeRun: (runId: string) => void
  startAgent: (input: StartAgentInput) => Promise<AgentRunSnapshot>
  writeInput: (runId: string, input: Buffer | string) => void
  getRun: (runId: string) => AgentRunSnapshot
  removeRun: (runId: string) => void
  stopRun: (runId: string) => void
  /** Resolves after the native PTY has emitted exit and Windows released its handles. */
  waitForRunExit?: (runId: string) => Promise<void>
}

const createRunId = () => randomUUID()
const WINDOWS_PTY_RELEASE_SETTLE_MS = 500
const isClosedPtyResizeError = (error: unknown) =>
  /cannot resize a pty that has already exited|pty seems to have been killed already|pty is not active|already exited/i.test(
    error instanceof Error ? error.message : String(error)
  )

const waitForWindowsPtyRelease = async () => {
  if (process.platform !== 'win32') return
  await new Promise<void>((resolve) => setTimeout(resolve, WINDOWS_PTY_RELEASE_SETTLE_MS))
}

const createSpawnEnv = (inputEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  return withoutManagementCredentials(createExecutionEnvironment(inputEnv))
}

export const createAgentManager = ({
  ptyOutputBus = createPtyOutputBus(),
}: {
  ptyOutputBus?: PtyOutputBus
} = {}): AgentManager => {
  const runs = new Map<string, AgentRunRecord>()
  const screens = new Map<string, TerminalStateMirror>()
  const runExitPromises = new Map<string, Promise<void>>()
  const runExitResolvers = new Map<string, () => void>()

  const getRunRecord = (runId: string) => {
    const run = runs.get(runId)
    if (!run) throw new Error(`Run not found: ${runId}`)
    return run
  }

  return {
    getOutputBus() {
      return ptyOutputBus
    },
    pauseRun(runId) {
      getRunRecord(runId).process.pause()
    },
    async startAgent(input) {
      if (!input.execution)
        throw new ResourceReservationError(
          'A valid resource reservation is required to spawn a PTY.'
        )
      const env = createSpawnEnv(input.env)
      let spawnCommand: ReturnType<typeof resolveSpawnCommand>
      try {
        input.execution.assertReserved()
        spawnCommand = resolveSpawnCommand(input.command, input.cwd, env, input.args ?? [])
      } catch (error) {
        input.execution.cancelBeforeSpawn()
        throw error
      }

      const runId = createRunId()
      let resolveRunExit = () => {}
      const runExitPromise = new Promise<void>((resolve) => {
        resolveRunExit = resolve
      })
      runExitPromises.set(runId, runExitPromise)
      runExitResolvers.set(runId, resolveRunExit)

      const run: AgentRunRecord = {
        inputSequence: 0,
        terminalSize: { cols: 80, rows: 24 },
        runId,
        agentId: input.agentId,
        pid: null,
        status: 'starting',
        output: '',
        exitCode: null,
        process: {
          isStopped() {
            return false
          },
          pause() {},
          pid: null,
          resize() {},
          resume() {},
          stop() {},
          write() {},
        },
      }

      if (input.onExit) run.onExit = input.onExit

      let pty: IPty | undefined
      const stopOnAbort = () => run.process.stop()

      try {
        const ptyOptions = {
          cwd: input.cwd,
          env,
          name: 'xterm-256color',
          // Vitest runs without a real Windows console. Winpty keeps the
          // integration suite deterministic there; normal Hive launches keep
          // node-pty's modern ConPTY default unless explicitly overridden.
          ...(process.env.HIVE_TEST_PTY_BACKEND === 'winpty' ? { useConpty: false } : {}),
        }
        input.execution.beginSpawn()
        runs.set(runId, run)
        pty = spawn(spawnCommand.command, spawnCommand.args, ptyOptions)
        const screen = new TerminalStateMirror(run.terminalSize)
        screens.set(runId, screen)
        pty.onData((chunk) => screen.write(chunk))
        pty.onExit(() => {
          screen.dispose()
          screens.delete(runId)
        })
        const pid = pty.pid
        let nativeExitObserved = false
        pty.onExit(() => {
          if (nativeExitObserved) return
          nativeExitObserved = true
          input.execution.signal?.removeEventListener('abort', stopOnAbort)
          void (async () => {
            try {
              await waitForWindowsPtyRelease()
              await input.afterNativeExit?.()
              input.execution.confirmExit(runId, pid)
            } catch (error) {
              try {
                input.execution.markUnconfirmed(
                  'Native exit cleanup or resource release could not be completed.'
                )
              } catch (markError) {
                console.error('[hive] could not persist exit recovery marker', { runId, markError })
              }
              console.error('[hive] cleanup or resource release failed after PTY exit', {
                runId,
                error,
              })
            } finally {
              runExitResolvers.delete(runId)
              resolveRunExit()
            }
          })()
        })
        attachAgentPty(run, pty, ptyOutputBus)
        input.execution.markStarted({ runId, pid, startedAt: Date.now() })
        input.execution.signal?.addEventListener('abort', stopOnAbort, { once: true })
        if (input.execution.signal?.aborted) stopOnAbort()
      } catch (error) {
        if (pty) {
          try {
            if (run.process.pid === null) pty.kill('SIGKILL')
            else run.process.stop()
          } catch (cleanupError) {
            input.execution.markUnconfirmed(`PTY cleanup failed for run ${runId}, PID ${pty.pid}`)
            throw new AggregateError(
              [error, cleanupError],
              'PTY startup failed and process exit could not be confirmed.'
            )
          }
          await runExitPromise
        } else input.execution.spawnFailed()
        runs.delete(runId)
        screens.get(runId)?.dispose()
        screens.delete(runId)
        runExitPromises.delete(runId)
        runExitResolvers.delete(runId)
        throw error
      }

      return toAgentRunSnapshot(run)
    },

    resizeRun(runId, cols, rows) {
      const run = getRunRecord(runId)
      // Browser layout observers can deliver one last resize after the PTY
      // exit event. Treat that normal teardown race as a no-op instead of
      // surfacing node-pty's "Cannot resize a pty that has already exited" to
      // the terminal UI.
      if (run.status === 'exited' || run.status === 'error' || run.process.isStopped()) return
      try {
        run.process.resize(cols, rows)
        run.terminalSize = { cols, rows }
        // Apply geometry before the child can emit a frame for that size.
        // Replaying old ANSI output at the latest dimensions loses this order.
        screens.get(runId)?.resize(cols, rows)
      } catch (error) {
        if (!isClosedPtyResizeError(error)) throw error
      }
    },

    resumeRun(runId) {
      getRunRecord(runId).process.resume()
    },

    writeInput(runId, text) {
      executeRemoteInput(runId, Buffer.byteLength(text), () => {
        const run = getRunRecord(runId)
        if (!isTerminalReplyOnly(text.toString())) run.inputSequence += 1
        run.process.write(text)
      })
    },

    getInputSequence(runId) {
      return getRunRecord(runId).inputSequence
    },
    getTerminalSize(runId) {
      return { ...getRunRecord(runId).terminalSize }
    },
    getTerminalScreen(runId) {
      getRunRecord(runId)
      const screen = screens.get(runId)
      if (!screen) throw new Error(`Terminal screen is unavailable for run: ${runId}`)
      return screen.getScreenText()
    },

    getRun(runId) {
      return toAgentRunSnapshot(getRunRecord(runId))
    },

    removeRun(runId) {
      screens.get(runId)?.dispose()
      screens.delete(runId)
      runs.delete(runId)
      if (!runExitResolvers.has(runId)) runExitPromises.delete(runId)
    },

    stopRun(runId) {
      const run = getRunRecord(runId)
      run.process.stop()
    },
    async waitForRunExit(runId) {
      await runExitPromises.get(runId)
    },
  }
}

export type { AgentManager, AgentRunRecord, AgentRunSnapshot, RunStatus, StartAgentInput }
