import { serializeDispatchRecord } from './dispatch-ledger-serializer.js'
import { getRequiredParam, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

export const workspaceDeliveryRoutes: RouteDefinition[] = [
  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/delivery',
    ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) return
      store.getWorkspaceSnapshot(workspaceId)
      const query = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams
      const page = store.deliveryHistory.page(workspaceId, {
        ...(query.has('limit') ? { limit: Number(query.get('limit')) } : {}),
        ...(query.has('cursor') ? { cursor: query.get('cursor') ?? '' } : {}),
        ...(query.has('filter') ? { filter: query.get('filter') ?? '' } : {}),
        ...(query.has('query') ? { query: query.get('query') ?? '' } : {}),
      })
      response.setHeader('Cache-Control', 'no-store')
      sendJson(response, 200, {
        ...page,
        items: page.items.map((item) => ({
          ...serializeDispatchRecord(item),
          delivery_flags: item.delivery_flags,
        })),
      })
    }
  ),
]
