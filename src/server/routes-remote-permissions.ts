import { RemotePermissionError } from './remote-permission-store.js'
import { getRequestPrincipal, requireLocalUser } from './request-principal.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'

export const remotePermissionRoutes: RouteDefinition[] = [
  route('GET', '/api/remote/access', ({ request, response, store }) => {
    const principal = getRequestPrincipal(request)
    const target = new URL(request.url ?? '/', 'http://localhost').searchParams.get('device_id')
    let deviceId: string
    if (principal?.kind === 'remote_device') {
      if (target && target !== principal.deviceId)
        throw new RemotePermissionError(
          'remote_device_forbidden',
          'Only your own device access is visible'
        )
      deviceId = principal.deviceId
    } else {
      requireLocalUser(request, store)
      if (!target)
        throw new RemotePermissionError('remote_device_required', 'device_id is required', 400)
      deviceId = target
    }
    sendJson(response, 200, store.remote.permissions.getAccess(deviceId))
  }),
  route('GET', '/api/remote/access-requests', ({ request, response, store }) => {
    const principal = getRequestPrincipal(request)
    if (principal?.kind !== 'remote_device') requireLocalUser(request, store)
    sendJson(response, 200, {
      requests: store.remote.permissions.listRequests(
        principal?.kind === 'remote_device' ? principal.deviceId : undefined
      ),
    })
  }),
  route('POST', '/api/remote/access-requests', async ({ request, response, store }) => {
    const principal = getRequestPrincipal(request)
    if (principal?.kind !== 'remote_device')
      throw new RemotePermissionError(
        'remote_device_required',
        'A paired device must request its own access'
      )
    const body = await readJsonBody<{
      workspace_id?: unknown
      actions?: unknown
      duration_ms?: unknown
    }>(request)
    if (!body || typeof body.workspace_id !== 'string')
      throw new RemotePermissionError('remote_workspace_required', 'workspace_id is required', 400)
    sendJson(
      response,
      201,
      store.remote.permissions.request(principal.deviceId, {
        workspaceId: body.workspace_id,
        actions: body.actions,
        durationMs: body.duration_ms,
      })
    )
  }),
  route(
    'PUT',
    '/api/remote/devices/:deviceId/scopes',
    async ({ params, request, response, store }) => {
      requireLocalUser(request, store)
      const body = await readJsonBody<{ workspace_ids?: unknown }>(request)
      sendJson(
        response,
        200,
        store.remote.permissions.setReadScopes(params.deviceId ?? '', body?.workspace_ids)
      )
    }
  ),
  route(
    'POST',
    '/api/remote/access-requests/:requestId/approve',
    ({ params, request, response, store }) => {
      requireLocalUser(request, store)
      sendJson(response, 200, store.remote.permissions.approve(params.requestId ?? ''))
    }
  ),
  route(
    'POST',
    '/api/remote/access-requests/:requestId/reject',
    ({ params, request, response, store }) => {
      requireLocalUser(request, store)
      store.remote.permissions.reject(params.requestId ?? '')
      response.statusCode = 204
      response.end()
    }
  ),
  route('POST', '/api/remote/grants/:grantId/revoke', ({ params, request, response, store }) => {
    requireLocalUser(request, store)
    store.remote.permissions.revokeGrant(params.grantId ?? '')
    response.statusCode = 204
    response.end()
  }),
]
