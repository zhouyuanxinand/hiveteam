export type ExecutionKind = 'orchestrator' | 'worker' | 'workspace_shell' | 'verification'

export interface ResourceLimits {
  max_running_total: number
  max_running_per_workspace: number
  max_workers_per_workspace: number
  max_verification_per_workspace: number
}

export const DEFAULT_RESOURCE_LIMITS: Readonly<ResourceLimits> = {
  max_running_total: 8,
  max_running_per_workspace: 4,
  max_workers_per_workspace: 12,
  max_verification_per_workspace: 1,
}

export const MAX_RESOURCE_LIMIT = 1000

export type ReservationState =
  | 'reserved'
  | 'spawn_pending'
  | 'running'
  | 'recovery_blocked'
  | 'released'

export interface ResourceReservation {
  id: string
  runtime_instance_id: string
  workspace_id: string
  execution_key: string
  kind: ExecutionKind
  state: ReservationState
  agent_id: string | null
  run_id: string | null
  pid: number | null
  process_identity: string | null
  reason: string | null
  created_at: number
  updated_at: number
  started_at: number | null
  released_at: number | null
}

export interface ResourceBudgetSnapshot {
  limits: ResourceLimits
  occupancy: {
    global: number
    by_workspace: Record<string, number>
    by_kind: Record<ExecutionKind, number>
  }
  reservations: ResourceReservation[]
}
