import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { readMemoryBudget, setMemoryBudget } from './team-memory-digest.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'
export const memoryContextRoutes: RouteDefinition[] = [
  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/memory/contexts',
    ({ request, response, store, params }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const id = params.workspaceId ?? ''
      store.getWorkspaceSnapshot(id)
      const dispatchId =
        new URL(request.url ?? '/', 'http://localhost').searchParams.get('dispatch_id') ?? undefined
      sendJson(response, 200, {
        contexts: store.memory.contexts(id, dispatchId),
        budget: readMemoryBudget(store.settings, id, 'dispatch'),
        excluded_scope_reason: 'other_workspaces_not_authorized',
      })
    }
  ),
  route(
    'PUT',
    '/api/ui/workspaces/:workspaceId/memory/budget',
    async ({ request, response, store, params }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const id = params.workspaceId ?? ''
      store.getWorkspaceSnapshot(id)
      const body = await readJsonBody<{ budget: unknown }>(request)
      setMemoryBudget(store.settings, id, body?.budget)
      sendJson(response, 200, { budget: readMemoryBudget(store.settings, id, 'dispatch') })
    }
  ),
]
