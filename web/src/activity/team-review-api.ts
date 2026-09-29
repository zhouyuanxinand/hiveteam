import type { TeamReviewView } from '../../../src/shared/team-review.js'
import { apiFetch, readErrorMessage } from '../api.js'

export const readTeamReviews = async (
  workspaceId: string,
  dispatchId: string
): Promise<TeamReviewView[]> => {
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/dispatches/${encodeURIComponent(dispatchId)}/review-requests`
  )
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Unable to load temporary reviews'))
  return response.json() as Promise<TeamReviewView[]>
}
