import { randomUUID } from 'node:crypto'
import { spawn } from 'node-pty'
import { resolveSpawnCommand } from './agent-command-resolver.js'
import { attachAgentPty, toAgentRunSnapshot } from './agent-manager-support.js'
import { createPtyOutputBus, type PtyOutputBus } from './pty-output-bus.js'

type RunStatus = 'starting' | 'running' | 'exited' | 'error'

interface StartAgentInput {
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

const waitForWindowsPtyRelease = async () => {
  if (process.platform !== 'win32') return
  await new Promise<void>((resolve) => setTimeout(resolve, WINDOWS_PTY_RELEASE_SETTLE_MS))
}

const createSpawnEnv = (inputEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const env = { ...process.env, ...inputEnv }
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key]
  }
  return env
}

export const createAgentManager = ({
  ptyOutputBus = createPtyOutputBus(),
}: {
  ptyOutputBus?: PtyOutputBus
} = {}): AgentManager => {
  const runs = new Map<string, AgentRunRecord>()
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
      const env = createSpawnEnv(input.env)
      const spawnCommand = resolveSpawnCommand(input.command, input.cwd, env, input.args ?? [])

      const runId = createRunId()
      let resolveRunExit = () => {}
      const runExitPromise = new Promise<void>((resolve) => {
        resolveRunExit = resolve
      })
      runExitPromises.set(runId, runExitPromise)
      runExitResolvers.set(runId, resolveRunExit)

      const run: AgentRunRecord = {
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

      run.onExit = (event) => {
        try {
          input.onExit?.(event)
        } finally {
          void waitForWindowsPtyRelease().then(() => {
            runExitResolvers.delete(runId)
            resolveRunExit()
          })
        }
      }

      runs.set(runId, run)

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
        attachAgentPty(
          run,
          spawn(spawnCommand.command, spawnCommand.args, ptyOptions),
          ptyOutputBus
        )
      } catch (error) {
        runs.delete(runId)
        runExitPromises.delete(runId)
        runExitResolvers.delete(runId)
        throw error
      }

      return toAgentRunSnapshot(run)
    },

    resizeRun(runId, cols, rows) {
      getRunRecord(runId).process.resize(cols, rows)
    },

    resumeRun(runId) {
      getRunRecord(runId).process.resume()
    },

    writeInput(runId, text) {
      getRunRecord(runId).process.write(text)
    },

    getRun(runId) {
      return toAgentRunSnapshot(getRunRecord(runId))
    },

    removeRun(runId) {
      runs.delete(runId)
      runExitPromises.delete(runId)
      runExitResolvers.delete(runId)
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
