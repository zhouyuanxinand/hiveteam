import { randomUUID } from 'node:crypto'
import { createAgentRuntime } from '../../src/server/agent-runtime.js'
import type { ExecutionPolicyRuntime } from '../../src/server/execution-policy-runtime.js'
import {
  EXECUTION_POLICY_REVISION,
  type ExecutionPolicySnapshot,
} from '../../src/shared/execution-policy.js'
import { createTestResourceBudget } from './resource-budget.js'

/** State-machine unit tests isolate the policy compiler through its explicit port. */
const unitPolicy: Pick<ExecutionPolicyRuntime, 'prepare'> = {
  async prepare(input) {
    const bootstrap = input.bootstrap(input.config)
    const policyId = randomUUID()
    const sessionPolicy: ExecutionPolicySnapshot = {
      workspace_id: input.workspace.id,
      agent_id: input.agentId,
      role: 'coder',
      profile: 'trusted_unsafe',
      policy_revision: EXECUTION_POLICY_REVISION,
      policy_id: policyId,
      created_at: Date.now(),
      platform: process.platform,
      cli_id: input.config.command,
      cli_version: null,
      cli_fingerprint: 'unit-policy',
      enforcement: 'trusted_unsafe',
      requested: {
        read_roots: [input.workspace.path],
        write_roots: [input.workspace.path],
        network: 'unrestricted',
        credentials: 'trusted_cli',
        approval: 'cli_default',
        git_operations: ['unrestricted'],
      },
      actual: null,
      missing_capabilities: [],
      warnings: [],
      unsafe_grant: null,
      trust_automatic_workers: false,
      automatic_worker_trust_configured: false,
      automatic_worker: false,
      launch: {
        command: bootstrap.startConfig.command,
        args: bootstrap.startConfig.args ?? [],
        cwd: input.workspace.path,
        environment_keys: Object.keys(bootstrap.startEnv).sort(),
      },
    }
    return {
      ...bootstrap,
      cwd: input.workspace.path,
      policyId,
      sessionPolicy,
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
