import { apiFetch, readErrorMessage } from '../api.js'

export interface BranchUpdateView {
  branch: string
  target_branch: string
  workspace_path: string
  source_sha: string | null
  target_sha: string | null
  reason:
    | 'agents_running'
    | 'pending_tasks'
    | 'merge_in_progress'
    | 'source_dirty'
    | 'target_changed'
    | 'up_to_date'
    | null
  update: {
    source_sha: string
    target_sha: string
    state: 'running' | 'conflicted' | 'failed' | 'complete' | 'aborted'
    error: string | null
  } | null
  conflicts: string[]
  can_update: boolean
  can_continue: boolean
  can_abort: boolean
  patch: string
  truncated: boolean
}
const request = async <T>(url: string, body?: unknown): Promise<T> => {
  const response = await apiFetch(
    url,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
  )
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Working directory operation failed'))
  return response.json() as Promise<T>
}
export const requestBranchUpdate = (
  workspaceId: string,
  workerId: string,
  action?: 'update' | 'continue' | 'abort',
  preview?: BranchUpdateView
) =>
  request<BranchUpdateView>(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/workers/${encodeURIComponent(workerId)}/branch-update`,
    action && preview
      ? {
          action,
          source_sha: preview.source_sha,
          target_sha: action === 'update' ? preview.target_sha : preview.update?.target_sha,
        }
      : undefined
  )
export interface WorktreeResourceView {
  id: string
  workspace_id: string
  workspace_name: string
  checkout_path: string
  branch: string
  target_branch: string
  head_sha: string | null
  target_sha: string | null
  can_remove: boolean
  reason: string | null
  error: string | null
}
export interface WorktreeResources {
  total: number
  offset: number
  limit: number
  items: WorktreeResourceView[]
}
export const getWorktreeResources = (offset: number) =>
  request<WorktreeResources>(`/api/ui/worktree-resources?offset=${offset}&limit=10`)
export const removeWorktreeResource = (view: WorktreeResourceView) =>
  request<{ removed: boolean; branch: string }>(
    `/api/ui/worktree-resources/${encodeURIComponent(view.id)}/remove`,
    { head_sha: view.head_sha, target_sha: view.target_sha }
  )
