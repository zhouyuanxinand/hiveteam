import type { AgentLaunchConfigInput, PersistedAgentRun } from './agent-run-store.js'
import type { AgentSessionContext } from './agent-session-context.js'
import type { NativeSessionStore } from './native-session-store.js'

type PersistedRunStatus = PersistedAgentRun['status']

export interface AgentRunStorePort {
  checkpointShutdownRuns: (runIds: string[]) => void
  close?: () => void
  insertAgentRun: (
    runId: string,
    agentId: string,
    startedAt: number,
    pid: number | null,
    status?: PersistedRunStatus,
    exitCode?: number | null,
    endedAt?: number | null
  ) => void
  listAgentRuns: (agentId: string) => PersistedAgentRun[]
  listLaunchConfigs: () => Array<{
    agentId: string
    config: AgentLaunchConfigInput
    workspaceId: string
  }>
  markUnfinishedRunsStale: (endedAt?: number) => void
  resetFastExitCount?: (agentId: string) => void
  deleteLaunchConfig: (workspaceId: string, agentId: string) => void
  saveLaunchConfig: (workspaceId: string, agentId: string, input: AgentLaunchConfigInput) => void
  updatePersistedRun: (
    runId: string,
    status: PersistedRunStatus,
    exitCode: number | null,
    endedAt: number | null
  ) => void
}

export interface AgentSessionStorePort {
  native?: NativeSessionStore
  getCaptureContext: (workspaceId: string, agentId: string) => AgentSessionContext | undefined
  saveCaptureContext: (workspaceId: string, agentId: string, context: AgentSessionContext) => void
  clearLastSessionId: (workspaceId: string, agentId: string) => void
  getLastSessionId: (workspaceId: string, agentId: string) => string | undefined
  setLastSessionId: (workspaceId: string, agentId: string, sessionId: string) => void
}
