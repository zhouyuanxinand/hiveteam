import { HttpError } from './http-errors.js'
import { route, sendJson } from './route-helpers.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

export const collaborationStatsRoutes = [
  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/collaboration-stats',
    ({ request, response, store, params }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const workspaceId = params.workspaceId ?? ''
      if (!store.listWorkspaces().some((workspace) => workspace.id === workspaceId))
        throw new HttpError(404, 'Workspace not found')
      const query = new URL(request.url ?? '/', 'http://localhost').searchParams
      response.setHeader('Cache-Control', 'no-store')
      sendJson(
        response,
        200,
        store.collaborationStats.read(workspaceId, query.get('period') ?? '30')
      )
    }
  ),
]
