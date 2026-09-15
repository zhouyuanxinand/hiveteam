import type { DispatchIntegrationView } from '../shared/worker-worktree.js'
import { BadRequestError } from './http-errors.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const serialize = (view: DispatchIntegrationView) => ({
  worktree: view.worktree
    ? {
        branch: view.worktree.branch,
        workspace_path: view.worktree.workspacePath,
        target_branch: view.worktree.targetBranch,
      }
    : null,
  source_sha: view.sourceSha,
  target_sha: view.targetSha,
  verification_id: view.verificationId,
  can_integrate: view.canIntegrate,
  reason: view.reason,
  integrated_at: view.integratedAt,
  patch: view.patch,
  truncated: view.truncated,
})
const base = '/api/ui/workspaces/:workspaceId/dispatches/:dispatchId/integration'
const ids = (params: Record<string, string>) => {
  if (!params.workspaceId || !params.dispatchId)
    throw new BadRequestError('Workspace and dispatch are required')
  return [params.workspaceId, params.dispatchId] as const
}
export const integrationRoutes: RouteDefinition[] = [
  route('GET', base, async ({ params, request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    sendJson(response, 200, serialize(await store.integrations.view(...ids(params))))
  }),
  route('POST', base, async ({ params, request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const body = await readJsonBody<{
      source_sha?: unknown
      target_sha?: unknown
      verification_id?: unknown
    }>(request)
    if (
      typeof body.source_sha !== 'string' ||
      !/^[0-9a-f]{40,64}$/u.test(body.source_sha) ||
      typeof body.target_sha !== 'string' ||
      !/^[0-9a-f]{40,64}$/u.test(body.target_sha) ||
      typeof body.verification_id !== 'string' ||
      !body.verification_id
    )
      throw new BadRequestError('Full source_sha, target_sha, and verification_id are required')
    sendJson(
      response,
      200,
      serialize(
        await store.integrations.integrate(...ids(params), {
          sourceSha: body.source_sha,
          targetSha: body.target_sha,
          verificationId: body.verification_id,
        })
      )
    )
  }),
]
