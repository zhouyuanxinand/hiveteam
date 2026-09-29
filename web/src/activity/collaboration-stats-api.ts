import type {
  CollaborationPeriod,
  CollaborationStatistics,
} from '../../../src/shared/collaboration-stats.js'
import { apiFetch, readErrorMessage } from '../api.js'

export const readCollaborationStats = async (
  workspaceId: string,
  period: CollaborationPeriod,
  signal: AbortSignal
): Promise<CollaborationStatistics> => {
  const query = new URLSearchParams({ period })
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/collaboration-stats?${query}`,
    { signal }
  )
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Unable to load collaboration statistics'))
  return response.json() as Promise<CollaborationStatistics>
}
