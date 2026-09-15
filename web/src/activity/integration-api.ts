import { apiFetch, readErrorMessage } from '../api.js'

export interface IntegrationPreview {
  worktree: { branch: string; workspace_path: string; target_branch: string } | null
  source_sha: string | null
  target_sha: string | null
  verification_id: string | null
  can_integrate: boolean
  reason:
    | 'source_dirty'
    | 'target_changed'
    | 'target_dirty'
    | 'accept_required'
    | 'agents_running'
    | 'pending_tasks'
    | 'target_diverged'
    | null
  integrated_at: number | null
  patch: string
  truncated: boolean
}
export const requestDispatchIntegration = async (
  workspaceId: string,
  dispatchId: string,
  preview?: IntegrationPreview
): Promise<IntegrationPreview> => {
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/dispatches/${encodeURIComponent(dispatchId)}/integration`,
    preview
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            source_sha: preview.source_sha,
            target_sha: preview.target_sha,
            verification_id: preview.verification_id,
          }),
        }
      : {}
  )
  if (!response.ok) throw new Error(await readErrorMessage(response, 'Integration request failed'))
  return response.json() as Promise<IntegrationPreview>
}
