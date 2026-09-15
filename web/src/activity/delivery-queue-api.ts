import type { DeliveryQueueState } from '../../../src/shared/delivery-queue.js'
import {
  apiFetch,
  type DispatchSummary,
  type DispatchSummaryPayload,
  fromDispatchPayload,
  readErrorMessage,
} from '../api.js'

interface QueueItem {
  workspace_id: string
  workspace_name: string
  worker_name: string
  state: DeliveryQueueState
  checked_at: number | null
  dispatch: DispatchSummary
}
export interface DeliveryQueue {
  total: number
  limit: number
  offset: number
  items: QueueItem[]
}
export const getDeliveryQueue = async (input: {
  offset: number
  workspaceId: string
  state: string
}): Promise<DeliveryQueue> => {
  const query = new URLSearchParams({ offset: String(input.offset), limit: '25' })
  if (input.workspaceId) query.set('workspace_id', input.workspaceId)
  if (input.state) query.set('state', input.state)
  const response = await apiFetch(`/api/ui/delivery-queue?${query}`)
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Delivery queue request failed'))
  const result = (await response.json()) as Omit<DeliveryQueue, 'items'> & {
    items: Array<Omit<QueueItem, 'dispatch'> & { dispatch: DispatchSummaryPayload }>
  }
  return {
    ...result,
    items: result.items.map((item) => ({ ...item, dispatch: fromDispatchPayload(item.dispatch) })),
  }
}
