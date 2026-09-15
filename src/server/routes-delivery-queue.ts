import { type DeliveryQueueState, deliveryQueueStates } from '../shared/delivery-queue.js'
import { serializeDispatchRecord } from './dispatch-ledger-serializer.js'
import { BadRequestError } from './http-errors.js'
import { route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

export const deliveryQueueRoutes: RouteDefinition[] = [
  route('GET', '/api/ui/delivery-queue', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const params = new URL(request.url ?? '/', 'http://localhost').searchParams
    const limit = Number(params.get('limit') ?? 25)
    const offset = Number(params.get('offset') ?? 0)
    const state = params.get('state')
    const workspaceId = params.get('workspace_id')
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      (state && !deliveryQueueStates.includes(state as DeliveryQueueState))
    )
      throw new BadRequestError('Invalid delivery queue pagination or state')
    const result = store.deliveryQueue.list({
      limit,
      offset,
      ...(state ? { state: state as DeliveryQueueState } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    })
    sendJson(response, 200, {
      ...result,
      items: result.items.map((item) => ({
        workspace_id: item.workspaceId,
        workspace_name: item.workspaceName,
        worker_name: item.workerName,
        state: item.state,
        checked_at: item.checkedAt,
        dispatch: serializeDispatchRecord(item.dispatch),
      })),
    })
  }),
]
