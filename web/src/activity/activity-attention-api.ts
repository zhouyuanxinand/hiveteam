import type { AttentionPage } from '../../../src/shared/activity-attention.js'
import { apiFetch, fromDispatchPayload, readErrorMessage } from '../api.js'

export interface AgentInspection {
  workspaceId: string
  agentId: string
  sequence: number
}
export const readAttention = async (
  workspaceId: string,
  filter: string,
  cursor: string | null,
  signal: AbortSignal
): Promise<AttentionPage> => {
  const query = new URLSearchParams({ filter, limit: '25' })
  if (cursor) query.set('cursor', cursor)
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/attention?${query}`,
    { signal }
  )
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Unable to load needs attention'))
  return response.json() as Promise<AttentionPage>
}
export const readAttentionDispatch = async (
  workspaceId: string,
  dispatchId: string,
  signal: AbortSignal
) => {
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/dispatches/${encodeURIComponent(dispatchId)}`,
    { signal }
  )
  if (!response.ok) throw new Error(await readErrorMessage(response, 'Unable to load report'))
  return fromDispatchPayload((await response.json()) as Parameters<typeof fromDispatchPayload>[0])
}
