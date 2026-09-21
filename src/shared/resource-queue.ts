import type { ExecutionKind } from './resource-budget.js'

export type ResourceQueueSource =
  | 'dispatch'
  | 'scenario'
  | 'recovery'
  | 'verification'
  | 'integration_candidate'
export type ResourceQueueState = 'queued' | 'starting' | 'started' | 'failed' | 'cancelled'
export interface ResourceQueueEntry {
  id: string
  workspace_id: string
  agent_id: string | null
  execution_key: string
  kind: ExecutionKind
  source: ResourceQueueSource
  status: ResourceQueueState
  reason: string | null
  created_at: number
  updated_at: number
  run_id: string | null
  attempts: number
}
