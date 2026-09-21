import { BadRequestError, HttpError } from './http-errors.js'
import { requireLocalUser } from './request-principal.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { authenticateCliAgent } from './team-authz.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const workspacePath = '/api/ui/workspaces/:workspaceId/message-deliveries'
export const messageDeliveryRoutes: RouteDefinition[] = [
  route('GET', workspacePath, ({ request, response, store, params }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const id = params.workspaceId ?? ''
    store.getWorkspaceSnapshot(id)
    sendJson(response, 200, store.dispatchDelivery.view(id))
  }),
  route('GET', `${workspacePath}/:deliveryId/events`, ({ request, response, store, params }) => {
    requireLocalUser(request, store)
    const record = store.dispatchDelivery.records.get(params.deliveryId ?? '')
    if (!record || record.workspace_id !== params.workspaceId)
      throw new HttpError(404, 'Delivery not found')
    sendJson(response, 200, {
      delivery_events: store.dispatchDelivery.records.events(record.id),
      health_events: store.dispatchDelivery.health.events(record.dispatch_id),
    })
  }),
  route(
    'POST',
    `${workspacePath}/:deliveryId/resolve`,
    async ({ request, response, store, params }) => {
      requireLocalUser(request, store)
      const body = await readJsonBody<{
        action?: unknown
        reason?: unknown
        acknowledge_resend?: unknown
        composer_safe?: unknown
      }>(request)
      const id = params.deliveryId ?? '',
        workspaceId = params.workspaceId ?? ''
      const current = store.dispatchDelivery.records.get(id)
      if (!current || current.workspace_id !== workspaceId)
        throw new HttpError(404, 'Delivery not found')
      if (body.action === 'recheck') {
        store.dispatchDelivery.records.event(
          id,
          'manual_recheck',
          'local_user',
          'Requested receipt-only reconciliation'
        )
        sendJson(response, 200, { confirmed: store.dispatchDelivery.recheck(id) })
        return
      }
      if (body.action !== 'handled' && body.action !== 'resend')
        throw new BadRequestError('action must be recheck, handled, or resend')
      if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 2000)
        throw new BadRequestError('A reason of 1–2000 characters is required')
      if (body.composer_safe !== true)
        throw new BadRequestError(
          'Confirm the recipient composer is safe before releasing its queue'
        )
      if (body.action === 'resend' && body.acknowledge_resend !== true)
        throw new BadRequestError('Resending may repeat work; explicit acknowledgement is required')
      store.dispatchDelivery.resolve(workspaceId, id, body.action, 'local_user', body.reason.trim())
      sendJson(response, 200, store.dispatchDelivery.view(workspaceId))
    }
  ),
  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/dispatch-timeouts',
    ({ request, response, store, params }) => {
      requireLocalUser(request, store)
      const id = params.workspaceId ?? ''
      store.getWorkspaceSnapshot(id)
      sendJson(response, 200, store.dispatchDelivery.health.settings(id))
    }
  ),
  route(
    'PUT',
    '/api/ui/workspaces/:workspaceId/dispatch-timeouts',
    async ({ request, response, store, params }) => {
      requireLocalUser(request, store)
      const id = params.workspaceId ?? ''
      store.getWorkspaceSnapshot(id)
      const body = await readJsonBody<unknown>(request)
      sendJson(response, 200, store.dispatchDelivery.health.configure(id, body, 'local_user'))
    }
  ),
  route(
    'PUT',
    '/api/ui/workspaces/:workspaceId/dispatches/:dispatchId/timeouts',
    async ({ request, response, store, params }) => {
      requireLocalUser(request, store)
      const body = await readJsonBody<unknown>(request)
      sendJson(
        response,
        200,
        store.dispatchDelivery.health.configure(
          params.workspaceId ?? '',
          body,
          'local_user',
          params.dispatchId ?? ''
        )
      )
    }
  ),
  route(
    'POST',
    '/api/ui/workspaces/:workspaceId/dispatches/:dispatchId/cancellation-confirmation',
    async ({ request, response, store, params }) => {
      requireLocalUser(request, store)
      const dispatch = store.getDispatch(params.workspaceId ?? '', params.dispatchId ?? '')
      if (!dispatch) throw new HttpError(404, 'Dispatch not found')
      const body = await readJsonBody<{ reason?: unknown; acknowledge_stopped?: unknown }>(request)
      if (
        typeof body.reason !== 'string' ||
        !body.reason.trim() ||
        body.reason.length > 2000 ||
        body.acknowledge_stopped !== true
      )
        throw new BadRequestError('Confirm that this task stopped and provide a reason')
      store.dispatchDelivery.health.confirmCancellation(
        dispatch.workspaceId,
        dispatch.id,
        dispatch.toAgentId,
        'manual',
        'local_user',
        body.reason.trim()
      )
      sendJson(response, 200, {
        health: store.dispatchDelivery.health.get(dispatch.id),
        other_open_dispatches: store.dispatchDelivery.stopImpact(
          dispatch.workspaceId,
          dispatch.toAgentId
        ),
      })
    }
  ),
  route('GET', '/api/team/deliveries', ({ request, response, store }) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const workspaceId = url.searchParams.get('project_id') ?? ''
    const agentId = request.headers['x-hive-agent-id']
    const token = request.headers['x-hive-agent-token']
    if (typeof agentId !== 'string' || typeof token !== 'string')
      throw new BadRequestError('Agent headers are required')
    const agent = authenticateCliAgent({
      request,
      fromAgentId: agentId,
      token,
      workspaceId,
      getAgent: store.getAgent,
      validateToken: store.validateAgentToken,
    })
    sendJson(
      response,
      200,
      store.dispatchDelivery.view(workspaceId, agent.role === 'orchestrator' ? undefined : agentId)
    )
  }),
]
