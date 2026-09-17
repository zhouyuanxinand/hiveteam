import { route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

export const agentConversationRoutes: RouteDefinition[] = [
  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/agents/:agentId/conversation',
    async ({ request, response, params, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      response.setHeader('Cache-Control', 'no-store')
      sendJson(
        response,
        200,
        await store.readAgentConversation(params.workspaceId ?? '', params.agentId ?? '')
      )
    }
  ),
]
