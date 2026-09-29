import { BadRequestError } from './http-errors.js'
import { getPlatformRecoveryStatus, setPlatformAutostart } from './platform-recovery.js'
import { requireLocalUser } from './request-principal.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'

export const platformRecoveryRoutes: RouteDefinition[] = [
  route('GET', '/api/ui/platform/recovery', async ({ request, response, store }) => {
    requireLocalUser(request, store)
    response.setHeader('cache-control', 'no-store')
    sendJson(response, 200, await getPlatformRecoveryStatus())
  }),
  route('PUT', '/api/ui/platform/recovery/autostart', async ({ request, response, store }) => {
    requireLocalUser(request, store)
    const body = await readJsonBody<unknown>(request)
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !('enabled' in body) ||
      typeof body.enabled !== 'boolean'
    )
      throw new BadRequestError('Provide only enabled as a boolean.')
    response.setHeader('cache-control', 'no-store')
    sendJson(response, 200, await setPlatformAutostart(body.enabled))
  }),
]
