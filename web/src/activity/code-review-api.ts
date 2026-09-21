import type {
  CodeReviewConclusion,
  CodeReviewContext,
  CodeReviewRecord,
  CodeReviewVersion,
  CodeReviewView,
} from '../../../src/shared/code-review.js'
import { apiFetch, readErrorMessage } from '../api.js'

const root = (workspaceId: string, dispatchId: string) =>
  `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/dispatches/${encodeURIComponent(dispatchId)}/reviews`
const read = async <T>(response: Response): Promise<T> => {
  if (!response.ok) throw new Error(await readErrorMessage(response, 'Code review request failed'))
  return response.json() as Promise<T>
}
const post = (path: string, body: unknown) =>
  apiFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
export const readCodeReview = async (workspaceId: string, dispatchId: string) =>
  read<CodeReviewContext>(await apiFetch(`${root(workspaceId, dispatchId)}/context`))
export const submitCodeReview = async (
  workspaceId: string,
  dispatchId: string,
  body: {
    request_id: string
    version: CodeReviewVersion
    conclusion: CodeReviewConclusion
    summary: string
  }
) => read<CodeReviewRecord>(await post(root(workspaceId, dispatchId), body))
export const acceptCodeReview = async (
  workspaceId: string,
  dispatchId: string,
  review: CodeReviewRecord
) =>
  read<CodeReviewView>(
    await post(`${root(workspaceId, dispatchId)}/${encodeURIComponent(review.id)}/accept`, {
      version: {
        repository_id: review.repository_id,
        source_sha: review.source_sha,
        base_sha: review.base_sha,
        report_revision: review.report_revision,
      },
    })
  )
