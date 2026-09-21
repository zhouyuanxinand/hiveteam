import { requireLocalUser } from './request-principal.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'

const path = '/api/ui/workspaces/:workspaceId/agents/:agentId/native-session'
export const nativeSessionRoutes: RouteDefinition[] = [
  route('GET', path, async ({ request, response, store, params }) => {
    requireLocalUser(request, store)
    response.setHeader('cache-control', 'no-store')
    sendJson(
      response,
      200,
      await store.nativeSessions.view(params.workspaceId ?? '', params.agentId ?? '')
    )
  }),
  route('POST', path, async ({ request, response, store, params }) => {
    requireLocalUser(request, store)
    response.setHeader('cache-control', 'no-store')
    sendJson(
      response,
      200,
      await store.nativeSessions.change(
        params.workspaceId ?? '',
        params.agentId ?? '',
        await readJsonBody<unknown>(request)
      )
    )
  }),
]
