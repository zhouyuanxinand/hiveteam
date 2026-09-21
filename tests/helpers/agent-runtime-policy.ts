import { randomUUID } from 'node:crypto'
import { createAgentRuntime } from '../../src/server/agent-runtime.js'
import type { ExecutionPolicyRuntime } from '../../src/server/execution-policy-runtime.js'
import { createTestResourceBudget } from './resource-budget.js'

/** State-machine unit tests isolate the policy compiler through its explicit port. */
const unitPolicy: Pick<ExecutionPolicyRuntime, 'prepare'> = {
  async prepare(input) {
    return {
      ...input.bootstrap(input.config),
      cwd: input.workspace.path,
      policyId: randomUUID(),
      bindRun: () => {},
      assertCurrentPolicy: async () => {},
      close: async () => {},
    }
  },
}

export const createPolicyIsolatedAgentRuntime = (...args: Parameters<typeof createAgentRuntime>) =>
  createAgentRuntime(
    args[0],
    args[1],
    args[2],
    args[3],
    args[4],
    args[5],
    args[6],
    args[7],
    args[8],
    args[9],
    args[10],
    unitPolicy,
    args[12] ?? createTestResourceBudget()
  )
