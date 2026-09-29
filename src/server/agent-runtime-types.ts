import type { AgentRunSnapshot } from './agent-manager.js'
import type { SessionIdCaptureConfig } from './session-capture.js'

export interface RunSessionContext {
  capture: SessionIdCaptureConfig
  cwd: string
  sessionId?: string
}

// Runtime-only binding must never enter the legacy run JSON response.
export const RUN_SESSION_CONTEXT = Symbol('runSessionContext')

export interface LiveAgentRun extends AgentRunSnapshot {
  startedAt: number
  [RUN_SESSION_CONTEXT]?: RunSessionContext
}
