import type { AgentManager } from './agent-manager.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import type { LiveRunRegistry } from './live-run-registry.js'

export const closeAgentRuntime = async (
  agentManager: AgentManager | undefined,
  registry: LiveRunRegistry,
  syncRun: (run: LiveAgentRun) => LiveAgentRun,
  checkpointShutdownRuns: (runIds: string[]) => void
) => {
  const runs = registry.list()
  const activeRunIds: string[] = []
  for (const run of runs) {
    try {
      const { status } = syncRun(run)
      if (status === 'starting' || status === 'running') activeRunIds.push(run.runId)
    } catch {
      // A PTY may have already exited and been removed while the runtime is
      // closing. Persisting its final state is best effort during shutdown.
    }
  }
  // Commit recovery intent before any stop can synchronously emit a PTY exit.
  checkpointShutdownRuns(activeRunIds)

  for (const run of runs) {
    if (!agentManager) {
      registry.resolveExit(run.runId)
      continue
    }

    try {
      agentManager.stopRun(run.runId)
    } catch {
      // Treat an already-gone PTY as stopped so shutdown cannot wait forever
      // for an exit callback that can no longer arrive.
      registry.resolveExit(run.runId)
    }
  }

  await Promise.all(registry.listExitEntries().map((entry) => entry.promise))
  // The registry is resolved from the PTY exit callback. The concrete
  // manager also waits for the native PTY handle to settle on Windows before
  // its run is removed, so callers can safely delete a workspace immediately
  // after runtime.close().
  if (agentManager?.waitForRunExit) {
    await Promise.all(runs.map((run) => agentManager.waitForRunExit?.(run.runId)))
  }

  for (const run of registry.list()) {
    agentManager?.removeRun(run.runId)
    registry.remove(run.runId)
  }
}
