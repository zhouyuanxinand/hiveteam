import { BadRequestError } from './http-errors.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { authenticateCliAgent, requireCommandForRole } from './team-authz.js'
import type { TeamReviewRequest } from './team-review-runtime.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

export const teamReviewRoutes: RouteDefinition[] = [
  route('POST', '/api/team/review/request', async ({ request, response, store }) => {
    const body = await readJsonBody<
      TeamReviewRequest & { project_id?: string; from_agent_id?: string; token?: string }
    >(request, { limitBytes: 16000 })
    if (!body || typeof body.project_id !== 'string' || !body.project_id.trim())
      throw new BadRequestError('project_id is required')
    const actor = authenticateCliAgent({
      request,
      workspaceId: body.project_id,
      fromAgentId: body.from_agent_id,
      token: body.token,
      getAgent: store.getAgent,
      validateToken: store.validateAgentToken,
    })
    requireCommandForRole(actor, 'request_review')
    sendJson(
      response,
      201,
      await store.teamReviews.request(
        body.project_id,
        actor.id,
        body,
        String(request.socket.localPort ?? '')
      )
    )
  }),
  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/dispatches/:dispatchId/review-requests',
    async ({ request, response, store, params }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      sendJson(
        response,
        200,
        await store.teamReviews.list(params.workspaceId ?? '', params.dispatchId ?? '')
      )
    }
  ),
  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/review-requests/:requestId',
    async ({ request, response, store, params }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      sendJson(
        response,
        200,
        await store.teamReviews.get(params.workspaceId ?? '', params.requestId ?? '')
      )
    }
  ),
]
