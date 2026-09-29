import { serializeDispatchRecord } from './dispatch-ledger-serializer.js'
import { HttpError } from './http-errors.js'
import { getRequestPrincipal } from './request-principal.js'
import { route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

export const activityAttentionRoutes: RouteDefinition[] = [
  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/attention',
    ({ request, response, store, params }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const workspaceId = params.workspaceId ?? ''
      if (!store.listWorkspaces().some((workspace) => workspace.id === workspaceId))
        throw new HttpError(404, 'Workspace not found')
      const workspace = store.getWorkspaceSnapshot(workspaceId)
      const query = new URL(request.url ?? '/', 'http://localhost').searchParams
      const remote = store.remote
      const status =
        remote.tunnel?.status() ?? (remote.config.getDaemonToken() ? 'disabled' : 'loggedOut')
      const remoteStatus =
        getRequestPrincipal(request)?.kind !== 'remote_device' &&
        remote.config.isEnabled() &&
        !['online', 'connecting'].includes(status)
          ? status
          : null
      response.setHeader('Cache-Control', 'no-store')
      sendJson(
        response,
        200,
        store.attention.page(workspaceId, workspace.agents, {
          ...(query.has('limit') ? { limit: Number(query.get('limit')) } : {}),
          ...(query.has('filter') ? { filter: query.get('filter') ?? '' } : {}),
          ...(query.has('cursor') ? { cursor: query.get('cursor') ?? '' } : {}),
          remoteStatus,
        })
      )
    }
  ),
  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/dispatches/:dispatchId',
    ({ request, response, store, params }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      if (!store.listWorkspaces().some((workspace) => workspace.id === params.workspaceId))
        throw new HttpError(404, 'Workspace not found')
      const dispatch = store.getDispatch(params.workspaceId ?? '', params.dispatchId ?? '')
      if (!dispatch) throw new HttpError(404, 'Dispatch not found')
      response.setHeader('Cache-Control', 'no-store')
      sendJson(response, 200, serializeDispatchRecord(dispatch))
    }
  ),
]
