import { BadRequestError } from './http-errors.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'
import type { WorkerBranchRuntime } from './worker-branch-runtime.js'

const serialize = (view: Awaited<ReturnType<WorkerBranchRuntime['view']>>) => ({
  ...view,
  update: view.update
    ? {
        source_sha: view.update.sourceSha,
        target_sha: view.update.targetSha,
        state: view.update.state,
        error: view.update.error,
      }
    : null,
})
const base = '/api/ui/workspaces/:workspaceId/workers/:workerId/branch-update'
const ids = (params: Record<string, string>) => {
  if (!params.workspaceId || !params.workerId)
    throw new BadRequestError('Workspace and worker are required')
  return [params.workspaceId, params.workerId] as const
}
export const workerBranchRoutes: RouteDefinition[] = [
  route('GET', base, async ({ request, response, params, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    sendJson(response, 200, serialize(await store.branches.view(...ids(params))))
  }),
  route('POST', base, async ({ request, response, params, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const body = await readJsonBody<Record<string, unknown>>(request)
    if (
      !body ||
      (body.action !== 'update' && body.action !== 'continue' && body.action !== 'abort') ||
      typeof body.source_sha !== 'string' ||
      !/^[0-9a-f]{40,64}$/u.test(body.source_sha) ||
      typeof body.target_sha !== 'string' ||
      !/^[0-9a-f]{40,64}$/u.test(body.target_sha)
    )
      throw new BadRequestError('action, source_sha and target_sha are required')
    sendJson(
      response,
      200,
      serialize(
        await store.branches.act(...ids(params), {
          action: body.action,
          sourceSha: body.source_sha,
          targetSha: body.target_sha,
        })
      )
    )
  }),
]
