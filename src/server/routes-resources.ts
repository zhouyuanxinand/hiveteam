import type { ResourceLimits } from '../shared/resource-budget.js'
import { BadRequestError, ConflictError, HttpError } from './http-errors.js'
import { requireLocalUser } from './request-principal.js'
import { readResourceStatus } from './resource-status.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'

export const resourceRoutes: RouteDefinition[] = [
  route('GET', '/api/resources', ({ request, response, store }) => {
    requireLocalUser(request, store)
    response.setHeader('cache-control', 'no-store')
    sendJson(response, 200, readResourceStatus(store))
  }),
  route('PUT', '/api/resources', async ({ request, response, store }) => {
    requireLocalUser(request, store)
    const body = await readJsonBody<Partial<ResourceLimits>>(request)
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length)
      throw new BadRequestError('Provide resource limits to update.')
    store.resources.updateLimits(body, { actor: 'local_user' })
    sendJson(response, 200, readResourceStatus(store))
  }),
  route('POST', '/api/resources/queue/:queueId/cancel', ({ request, response, params, store }) => {
    requireLocalUser(request, store)
    const entry = store.resourceQueue.cancel(params.queueId ?? '')
    if (!entry) throw new HttpError(404, 'Queued execution not found')
    sendJson(response, 200, entry)
  }),
  route('POST', '/api/resources/reconcile', ({ request, response, store }) => {
    requireLocalUser(request, store)
    store.resources.recover()
    store.resourceQueue.wake()
    sendJson(response, 200, readResourceStatus(store))
  }),
  route(
    'POST',
    '/api/resources/reservations/:reservationId/cancel',
    ({ request, response, params, store }) => {
      requireLocalUser(request, store)
      const reservation = store.resources.getReservation(params.reservationId ?? '')
      if (!reservation) throw new HttpError(404, 'Execution reservation not found')
      if (
        reservation.state !== 'reserved' ||
        !reservation.agent_id ||
        reservation.runtime_instance_id !== store.resources.runtimeInstanceId ||
        (reservation.kind !== 'worker' && reservation.kind !== 'orchestrator')
      )
        throw new ConflictError(
          'Only a pending agent launch in this runtime can be cancelled here. Stop an active run through its terminal.'
        )
      store.cancelPendingAgentStart(reservation.workspace_id, reservation.agent_id)
      sendJson(response, 200, readResourceStatus(store))
    }
  ),
]
