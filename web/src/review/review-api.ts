import type {
  ReviewDocumentState,
  ReviewDraft,
  ReviewSubmission,
  SaveReviewDraft,
} from '../../../src/shared/workspace-review.js'
import { apiFetch, readErrorMessage } from '../api.js'

export const reviewRequest = async <T>(
  workspaceId: string,
  suffix: string,
  method = 'GET',
  body?: unknown
): Promise<T> => {
  const response = await apiFetch(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/review${suffix}`,
    {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }
  )
  if (!response.ok)
    throw new Error(await readErrorMessage(response, `Request failed (${response.status})`))
  return response.json() as Promise<T>
}
export const listReviewDocuments = (id: string) =>
  reviewRequest<{ paths: string[]; truncated: boolean }>(id, '/documents')
export const readReviewDocument = (id: string, path: string) =>
  reviewRequest<ReviewDocumentState>(id, `/document?path=${encodeURIComponent(path)}`)
export const saveReviewDraft = (id: string, draft: SaveReviewDraft) =>
  reviewRequest<ReviewDraft>(id, '/draft', 'PUT', draft)
export const submitReview = (id: string, requestId: string, path: string, version: number) =>
  reviewRequest<ReviewSubmission>(id, '/send', 'POST', {
    request_id: requestId,
    path,
    draft_version: version,
  })
