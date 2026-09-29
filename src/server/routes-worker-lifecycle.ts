import type { StaffingPolicy } from '../shared/worker-lifecycle.js'
import { BadRequestError } from './http-errors.js'
import { requireLocalUser } from './request-principal.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { CreateWorkerBody, RouteDefinition } from './route-types.js'
import { authenticateCliAgent, requireCommandForRole } from './team-authz.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const required = (value: unknown, field: string) => {
  if (typeof value !== 'string' || !value.trim()) throw new BadRequestError(`Missing ${field}`)
  return value
}
const policyPath = '/api/ui/workspaces/:workspaceId/staffing-policy'
const memberPath = '/api/ui/workspaces/:workspaceId/members'
export const workerLifecycleRoutes: RouteDefinition[] = [
  route('GET', policyPath, ({ request, response, params, store }) => {
    requireLocalUser(request, store)
    sendJson(response, 200, store.workerLifecycle.readPolicy(params.workspaceId ?? ''))
  }),
  route('PUT', policyPath, async ({ request, response, params, store }) => {
    requireLocalUser(request, store)
    sendJson(
      response,
      200,
      store.workerLifecycle.updatePolicy(
        params.workspaceId ?? '',
        await readJsonBody<StaffingPolicy>(request)
      )
    )
  }),
  route('GET', `${memberPath}/retired`, ({ request, response, params, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    sendJson(response, 200, store.workerLifecycle.listRetired(params.workspaceId ?? ''))
  }),
  route('GET', `${memberPath}/:workerId`, ({ request, response, params, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    sendJson(
      response,
      200,
      store.workerLifecycle.get(params.workspaceId ?? '', params.workerId ?? '')
    )
  }),
  route('POST', `${memberPath}/:workerId/retire`, ({ request, response, params, store }) => {
    requireLocalUser(request, store)
    sendJson(
      response,
      200,
      store.workerLifecycle.dismiss(params.workspaceId ?? '', params.workerId ?? '')
    )
  }),
  route('POST', '/api/team/spawn', async ({ request, response, store }) => {
    const body = await readJsonBody<
      CreateWorkerBody & { project_id?: unknown; from_agent_id?: unknown; token?: string }
    >(request)
    const workspaceId = required(body?.project_id, 'project_id')
    const actor = authenticateCliAgent({
      request,
      workspaceId,
      fromAgentId: required(body.from_agent_id, 'from_agent_id'),
      token: body.token,
      getAgent: store.getAgent,
      validateToken: store.validateAgentToken,
    })
    requireCommandForRole(actor, 'spawn')
    sendJson(
      response,
      201,
      await store.workerLifecycle.create(
        workspaceId,
        body,
        String(request.socket.localPort ?? ''),
        actor.id
      )
    )
  }),
  route('POST', '/api/team/dismiss', async ({ request, response, store }) => {
    const body = await readJsonBody<{
      project_id?: unknown
      from_agent_id?: unknown
      token?: string
      worker_id?: unknown
    }>(request)
    const workspaceId = required(body?.project_id, 'project_id')
    const actor = authenticateCliAgent({
      request,
      workspaceId,
      fromAgentId: required(body.from_agent_id, 'from_agent_id'),
      token: body.token,
      getAgent: store.getAgent,
      validateToken: store.validateAgentToken,
    })
    requireCommandForRole(actor, 'dismiss')
    sendJson(
      response,
      200,
      store.workerLifecycle.dismiss(workspaceId, required(body.worker_id, 'worker_id'), actor.id)
    )
  }),
  route('GET', '/api/team/staffing', ({ request, response, store }) => {
    const workspaceId = required(
      new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('project_id'),
      'project_id'
    )
    const token = request.headers['x-hive-agent-token']
    const actor = authenticateCliAgent({
      request,
      workspaceId,
      fromAgentId: required(request.headers['x-hive-agent-id'], 'x-hive-agent-id'),
      token: Array.isArray(token) ? token[0] : token,
      getAgent: store.getAgent,
      validateToken: store.validateAgentToken,
    })
    requireCommandForRole(actor, 'spawn')
    sendJson(response, 200, store.workerLifecycle.readPolicy(workspaceId))
  }),
]
