import type {
  DeliveryFilter,
  WorkspaceDeliveryPage,
} from '../../../src/shared/workspace-delivery.js'
import {
  apiFetch,
  type DispatchSummary,
  type DispatchSummaryPayload,
  fromDispatchPayload,
  readErrorMessage,
} from '../api.js'

export const getWorkspaceDelivery = async (
  workspaceId: string,
  input: {
    limit?: number
    filter?: DeliveryFilter
    query?: string
    cursor?: string | undefined
  } = {}
): Promise<WorkspaceDeliveryPage<DispatchSummary>> => {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(input))
    if (value !== undefined) query.set(key, String(value))
  const response = await apiFetch(`/api/ui/workspaces/${workspaceId}/delivery?${query}`)
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Failed to load delivery history'))
  const page = (await response.json()) as WorkspaceDeliveryPage<DispatchSummaryPayload>
  return {
    ...page,
    items: page.items.map((item) => ({
      ...fromDispatchPayload(item),
      delivery_flags: item.delivery_flags,
    })),
  }
}
