import { BadRequestError } from './http-errors.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const base = '/api/ui/worktree-resources'
export const worktreeResourceRoutes: RouteDefinition[] = [
  route('GET', base, async ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const params = new URL(request.url ?? '/', 'http://localhost').searchParams
    const limit = Number(params.get('limit') ?? 10)
    const offset = Number(params.get('offset') ?? 0)
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 25 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new BadRequestError('Invalid pagination')
    const result = await store.worktreeResources.list(limit, offset)
    sendJson(response, 200, {
      ...result,
      items: result.items.map(({ resource, ...item }) => ({
        ...item,
        id: resource.workerId,
        workspace_name: resource.workspaceName,
        workspace_id: resource.workspaceId,
        checkout_path: resource.checkoutPath,
        branch: resource.branch,
        target_branch: resource.targetBranch,
        error: resource.error,
      })),
    })
  }),
  route('POST', `${base}/:id/remove`, async ({ request, response, params, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const body = await readJsonBody<Record<string, unknown>>(request)
    if (
      !params.id ||
      !body ||
      typeof body.head_sha !== 'string' ||
      !/^[0-9a-f]{40,64}$/u.test(body.head_sha) ||
      typeof body.target_sha !== 'string' ||
      !/^[0-9a-f]{40,64}$/u.test(body.target_sha)
    )
      throw new BadRequestError('Full head_sha and target_sha are required')
    sendJson(
      response,
      200,
      await store.worktreeResources.remove(params.id, {
        headSha: body.head_sha,
        targetSha: body.target_sha,
      })
    )
  }),
]
