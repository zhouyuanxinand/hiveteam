import type { CiState, PullRequestCheck } from '../../../src/shared/pull-request.js'
import { apiFetch, readErrorMessage } from '../api.js'

export interface PullRequestView {
  repository: string | null
  branch: string | null
  base_branch: string | null
  head_sha: string | null
  verification_id: string | null
  can_publish: boolean
  reason:
    | 'isolation_required'
    | 'github_remote_required'
    | 'source_dirty'
    | 'accept_required'
    | 'pending_tasks'
    | 'agents_running'
    | 'destination_changed'
    | 'publishing'
    | 'pull_request_closed'
    | 'published'
    | null
  publication: {
    head_sha: string
    verification_id: string
    repository: string
    branch: string
    base_branch: string
    state: 'publishing' | 'published' | 'failed'
    number: number | null
    error: string | null
    updated_at: number
    snapshot: {
      number: number
      url: string
      title: string
      state: 'open' | 'closed' | 'merged'
      draft: boolean
      head_sha: string
      head_branch: string
      base_sha: string
      base_branch: string
      ci_state: CiState
      checks: PullRequestCheck[]
      checked_at: number
    } | null
  } | null
}
export const requestPullRequest = async (
  workspaceId: string,
  dispatchId: string,
  action?: 'refresh' | { preview: PullRequestView; title: string; body: string }
): Promise<PullRequestView> => {
  const url = `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/dispatches/${encodeURIComponent(dispatchId)}/pull-request`
  const response = await apiFetch(
    url + (action === 'refresh' ? '/refresh' : ''),
    action
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            action === 'refresh'
              ? {}
              : {
                  head_sha: action.preview.head_sha,
                  verification_id: action.preview.verification_id,
                  repository: action.preview.repository,
                  branch: action.preview.branch,
                  base_branch: action.preview.base_branch,
                  title: action.title,
                  body: action.body,
                }
          ),
        }
      : {}
  )
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Pull request operation failed'))
  return response.json() as Promise<PullRequestView>
}
