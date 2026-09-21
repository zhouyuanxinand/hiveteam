import type { ResourceBudgetSnapshot } from './resource-budget.js'
import type { ResourceQueueEntry } from './resource-queue.js'

export interface ResourceStatus extends ResourceBudgetSnapshot {
  queue: ResourceQueueEntry[]
  workspaces: Array<{ workspace_id: string; name: string; worker_count: number }>
  occupants: Array<{
    reservation_id: string
    name: string
    run_id: string | null
    can_stop: boolean
    can_cancel: boolean
  }>
}
