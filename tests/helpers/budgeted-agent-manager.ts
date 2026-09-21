import { createAgentManager, type StartAgentInput } from '../../src/server/agent-manager.js'
import {
  createManagedExecution,
  type ManagedExecution,
} from '../../src/server/managed-execution.js'
import { createTestResourceBudget } from './resource-budget.js'

/** Existing PTY fixtures explicitly acquire a real admission lease for each synthetic child. */
export const createBudgetedTestAgentManager = (...args: Parameters<typeof createAgentManager>) => {
  const manager = createAgentManager(...args)
  const runIds = new Set<string>()
  const resources = createTestResourceBudget(async () => {
    for (const runId of runIds) {
      const run = manager.getRun(runId)
      if (run.status === 'running' || run.status === 'starting') manager.stopRun(runId)
      await manager.waitForRunExit?.(runId)
    }
  })
  return {
    ...manager,
    removeRun(runId: string) {
      runIds.delete(runId)
      manager.removeRun(runId)
    },
    async startAgent(input: Omit<StartAgentInput, 'execution'> & { execution?: ManagedExecution }) {
      const execution =
        input.execution ??
        createManagedExecution(
          resources,
          resources.reserve({
            workspaceId: 'synthetic-pty-fixture',
            executionKey: `agent:${input.agentId}`,
            agentId: input.agentId,
            kind: 'worker',
          })
        )
      const run = await manager.startAgent({ ...input, execution })
      runIds.add(run.runId)
      return run
    },
  }
}
