import { ForbiddenError } from './http-errors.js'
import { HIVE_REMOTE_DEVICE_HEADER, HIVE_REMOTE_SECRET_HEADER } from './remote-loopback-auth.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { readCookie } from './ui-auth-helpers.js'

export const uiRoutes: RouteDefinition[] = [
  route('GET', '/api/ui/session', ({ request, response, store }) => {
    if (
      request.headers[HIVE_REMOTE_SECRET_HEADER] ||
      request.headers[HIVE_REMOTE_DEVICE_HEADER] ||
      !store.validateUiToken(readCookie(request.headers.cookie, 'hive_ui_token'))
    ) {
      throw new ForbiddenError('UI bootstrap required; reopen HiveTeam from its launcher')
    }
    response.setHeader('cache-control', 'no-store')
    sendJson(response, 200, { ok: true })
  }),
  route('POST', '/api/ui/session', async ({ request, response, store }) => {
    // Remote tunnel requests must never mint a desktop identity.
    if (request.headers[HIVE_REMOTE_SECRET_HEADER] || request.headers[HIVE_REMOTE_DEVICE_HEADER]) {
      throw new ForbiddenError('UI bootstrap requires the local launcher')
    }
    const body = await readJsonBody<{ bootstrap_token?: unknown }>(request, { limitBytes: 1024 })
    if (typeof body.bootstrap_token !== 'string') {
      throw new ForbiddenError('UI bootstrap required; reopen HiveTeam from its launcher')
    }
    const token = store.exchangeUiBootstrap(body.bootstrap_token)
    response.setHeader('cache-control', 'no-store')
    response.setHeader('set-cookie', `hive_ui_token=${token}; Path=/; HttpOnly; SameSite=Strict`)
    sendJson(response, 200, { ok: true })
  }),
]
