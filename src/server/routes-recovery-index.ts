import { BadRequestError } from './http-errors.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { authenticateCliAgent, requireCommandForRole } from './team-authz.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'
export const recoveryIndexRoutes: RouteDefinition[] = [
  route('POST', '/api/team/recovery', async ({ request, response, store }) => {
    const body = await readJsonBody<{
      project_id: string
      from_agent_id: string
      token: string
      cursor?: string
      limit?: number
    }>(request)
    if (
      !body ||
      typeof body.project_id !== 'string' ||
      (body.cursor !== undefined && typeof body.cursor !== 'string')
    )
      throw new BadRequestError('Invalid recovery request')
    const actor = authenticateCliAgent({
      request,
      workspaceId: body.project_id,
      fromAgentId: body.from_agent_id,
      token: body.token,
      getAgent: store.getAgent,
      validateToken: store.validateAgentToken,
    })
    requireCommandForRole(actor, 'help')
    const workspace = store.getWorkspaceSnapshot(body.project_id).summary
    sendJson(
      response,
      200,
      store.recoveryIndex.page(workspace.id, workspace.path, actor, body.cursor, body.limit)
    )
  }),
  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/recovery-index',
    ({ request, response, store, params }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const workspace = store.getWorkspaceSnapshot(params.workspaceId ?? '').summary
      const url = new URL(request.url ?? '/', 'http://localhost')
      sendJson(
        response,
        200,
        store.recoveryIndex.page(
          workspace.id,
          workspace.path,
          { id: `${workspace.id}:orchestrator`, name: 'Orchestrator', role: 'orchestrator' },
          url.searchParams.get('cursor') ?? undefined,
          Number(url.searchParams.get('limit') ?? 25)
        )
      )
    }
  ),
]
