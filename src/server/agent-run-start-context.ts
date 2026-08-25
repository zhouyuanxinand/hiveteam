import type { WorkspaceSummary } from '../shared/types.js'
import type { AgentLaunchConfigInput, PersistedAgentRun } from './agent-run-store.js'
import type { AgentSessionStorePort } from './agent-runtime-ports.js'
import type { AgentTokenRegistry } from './agent-tokens.js'
import type { LiveRunRegistry } from './live-run-registry.js'
import type { SessionCaptureSnapshot } from './session-capture.js'

export type PersistedRunStatus = PersistedAgentRun['status']

export interface AgentRunStarterStorePort {
  insertAgentRun: (
    runId: string,
    agentId: string,
    startedAt: number,
    pid: number | null,
    status?: PersistedRunStatus,
    exitCode?: number | null,
    endedAt?: number | null
  ) => void
  updatePersistedRun: (
    runId: string,
    status: PersistedRunStatus,
    exitCode: number | null,
    endedAt: number | null
  ) => void
  resetFastExitCount?: (agentId: string) => void
}

export interface AgentRunExitContext {
  agentId: string
  handledRunExits: Set<string>
  onAgentExit: (workspaceId: string, agentId: string) => void
  registry: LiveRunRegistry
  sessionStore: AgentSessionStorePort
  startConfig: Pick<AgentLaunchConfigInput, 'resumedSessionId' | 'sessionIdCapture'>
  sessionCaptureDiscriminator?: SessionCaptureSnapshot['discriminator']
  store: AgentRunStarterStorePort
  token: string
  tokenRegistry: AgentTokenRegistry
  workspace: WorkspaceSummary
}
