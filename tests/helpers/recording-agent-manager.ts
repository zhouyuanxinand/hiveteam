import type { AgentManager, AgentRunSnapshot } from '../../src/server/agent-manager.js'
import { createPtyOutputBus } from '../../src/server/pty-output-bus.js'

export const createRecordingAgentManager = () => {
  const outputBus = createPtyOutputBus()
  const runs = new Map<string, AgentRunSnapshot>()
  const exitHandlers = new Map<
    string,
    ((event: { exitCode: number | null; runId: string }) => void) | undefined
  >()
  let sequence = 0
  let startCount = 0

  const manager: AgentManager = {
    getOutputBus: () => outputBus,
    getRun: (runId) => {
      const run = runs.get(runId)
      if (!run) throw new Error(`Run not found: ${runId}`)
      return { ...run }
    },
    pauseRun: () => {},
    removeRun: (runId) => {
      runs.delete(runId)
      exitHandlers.delete(runId)
    },
    resizeRun: () => {},
    resumeRun: () => {},
    startAgent: async (input) => {
      startCount += 1
      sequence += 1
      const run: AgentRunSnapshot = {
        agentId: input.agentId,
        exitCode: null,
        output: '› ',
        pid: 4_000 + sequence,
        runId: `recorded-run-${sequence}`,
        status: 'running',
      }
      runs.set(run.runId, run)
      exitHandlers.set(run.runId, input.onExit)
      return { ...run }
    },
    stopRun: (runId) => {
      const run = runs.get(runId)
      if (!run || run.status === 'exited' || run.status === 'error') return
      const exited = { ...run, exitCode: 0, status: 'exited' as const }
      runs.set(runId, exited)
      exitHandlers.get(runId)?.({ exitCode: 0, runId })
      outputBus.publishExit(runId)
      outputBus.clear(runId)
    },
    waitForRunExit: async () => {},
    writeInput: (runId, input) => {
      const run = runs.get(runId)
      if (!run) throw new Error(`Run not found: ${runId}`)
      const chunk = input.toString()
      runs.set(runId, { ...run, output: run.output + chunk })
      outputBus.publish(runId, chunk)
    },
  }

  return { getStartCount: () => startCount, manager }
}
