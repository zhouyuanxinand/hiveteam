export interface StaffingPolicy {
  enabled: boolean
  allowed_command_preset_ids: string[]
  max_ephemeral_workers: number
}
export interface WorkerLifecycleFields {
  lifecycleKind?: 'persistent' | 'ephemeral'
  spawnedByAgentId?: string
  retiredAt?: number
  preparationState?: 'preparing' | 'failed'
  preparationError?: string
}
export interface WorkerLifecyclePayload {
  lifecycle_kind?: 'persistent' | 'ephemeral'
  spawned_by_agent_id?: string
  retired_at?: number
  preparation_state?: 'preparing' | 'failed'
  preparation_error?: string
}
export const serializeWorkerLifecycle = (
  worker: WorkerLifecycleFields
): WorkerLifecyclePayload => ({
  ...(worker.lifecycleKind ? { lifecycle_kind: worker.lifecycleKind } : {}),
  ...(worker.spawnedByAgentId ? { spawned_by_agent_id: worker.spawnedByAgentId } : {}),
  ...(worker.retiredAt === undefined ? {} : { retired_at: worker.retiredAt }),
  ...(worker.preparationState ? { preparation_state: worker.preparationState } : {}),
  ...(worker.preparationError ? { preparation_error: worker.preparationError } : {}),
})
