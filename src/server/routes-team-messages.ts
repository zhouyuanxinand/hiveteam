import { DISPATCH_MESSAGE_KINDS, type DispatchMessageKind } from '../shared/dispatch-messages.js'
import { BadRequestError } from './http-errors.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { authenticateCliAgent, requireCommandForRole } from './team-authz.js'

const text = (value: unknown, field: string) => {
  if (typeof value !== 'string' || !value.trim()) throw new BadRequestError(`Missing ${field}`)
  return value
}
const integer = (value: string | null, fallback: number) => {
  if (value === null) return fallback
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new BadRequestError('Invalid pagination integer')
  return Number(value)
}

export const teamMessageRoutes: RouteDefinition[] = [
  route('POST', '/api/team/message', async ({ request, response, store }) => {
    const body = await readJsonBody<{
      project_id?: unknown
      from_agent_id?: unknown
      token?: string
      dispatch_id?: unknown
      kind?: unknown
      body?: unknown
      reply_to?: unknown
    }>(request)
    const workspaceId = text(body.project_id, 'project_id')
    const actorId = text(body.from_agent_id, 'from_agent_id')
    const actor = authenticateCliAgent({
      request,
      fromAgentId: actorId,
      workspaceId,
      token: body.token,
      getAgent: store.getAgent,
      validateToken: store.validateAgentToken,
    })
    requireCommandForRole(actor, 'message')
    if (
      typeof body.kind !== 'string' ||
      !(DISPATCH_MESSAGE_KINDS as readonly string[]).includes(body.kind)
    )
      throw new BadRequestError('kind must be note, question, answer, or progress')
    sendJson(
      response,
      202,
      store.dispatchMessages.send(workspaceId, text(body.dispatch_id, 'dispatch_id'), actorId, {
        kind: body.kind as DispatchMessageKind,
        body: text(body.body, 'body'),
        ...(body.reply_to === undefined ? {} : { replyTo: text(body.reply_to, 'reply_to') }),
      })
    )
  }),
  route('GET', '/api/team/messages', ({ request, response, store }) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const workspaceId = text(url.searchParams.get('project_id'), 'project_id')
    const actorId = text(request.headers['x-hive-agent-id'], 'x-hive-agent-id')
    const token = request.headers['x-hive-agent-token']
    const actor = authenticateCliAgent({
      request,
      fromAgentId: actorId,
      workspaceId,
      token: Array.isArray(token) ? token[0] : token,
      getAgent: store.getAgent,
      validateToken: store.validateAgentToken,
    })
    requireCommandForRole(actor, 'messages')
    sendJson(
      response,
      200,
      store.dispatchMessages.list(
        workspaceId,
        text(url.searchParams.get('dispatch_id'), 'dispatch_id'),
        actorId,
        integer(url.searchParams.get('after'), 0),
        integer(url.searchParams.get('limit'), 50)
      )
    )
  }),
]
