import { HIVE_SUPERVISOR_TOKEN_HEADER } from './external-goal-auth.js'
import { ExternalGoalDeliveryError } from './external-goal-bridge.js'
import { BadRequestError, ForbiddenError } from './http-errors.js'
import { HIVE_REMOTE_SECRET_HEADER } from './remote-loopback-auth.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'

const BODY_MAX_CHARS = 40_000
const SOURCE_MAX_CHARS = 80

const firstHeader = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value

const requireNonEmptyString = (value: unknown, field: string, maxChars = BODY_MAX_CHARS) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestError(`Missing ${field}`)
  }
  if ([...value].length > maxChars) {
    throw new BadRequestError(`${field} must be ${maxChars} characters or fewer`)
  }
  return value.trim()
}

const optionalContext = (value: unknown) => {
  if (value === undefined) return undefined
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new BadRequestError('context must be JSON-serializable')
  }
  if (serialized === undefined) throw new BadRequestError('context must be JSON-serializable')
  if ([...serialized].length > BODY_MAX_CHARS) {
    throw new BadRequestError(`context must be ${BODY_MAX_CHARS} characters or fewer`)
  }
  return value
}

const optionalNonNegativeNumber = (value: unknown, field: string) => {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new BadRequestError(`${field} must be a non-negative number`)
  }
  return value
}

const optionalNonNegativeInteger = (value: unknown, field: string) => {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new BadRequestError(`${field} must be a non-negative integer`)
  }
  return value
}

const isRemoteTunnelRequest = (
  request: Parameters<RouteDefinition['handler']>[0]['request'],
  store: Parameters<RouteDefinition['handler']>[0]['store']
) => store.validateRemoteTunnelSecret(firstHeader(request.headers[HIVE_REMOTE_SECRET_HEADER]))

const requireExternalController = (
  request: Parameters<RouteDefinition['handler']>[0]['request'],
  store: Parameters<RouteDefinition['handler']>[0]['store']
) => {
  if (isRemoteTunnelRequest(request, store)) {
    throw new ForbiddenError('Supervisor token is not available over the remote tunnel')
  }
  if (!store.validateSupervisorToken(firstHeader(request.headers[HIVE_SUPERVISOR_TOKEN_HEADER]))) {
    throw new ForbiddenError('External goal endpoint requires valid Supervisor token')
  }
}

const serializeSession = (session: {
  closedAt: number | null
  createdAt: number
  goal: string
  id: string
  source: string
  status: string
  summary: string | null
  title: string
  updatedAt: number
  workspaceId: string
}) => ({
  closed_at: session.closedAt,
  created_at: session.createdAt,
  goal: session.goal,
  id: session.id,
  source: session.source,
  status: session.status,
  summary: session.summary,
  title: session.title,
  updated_at: session.updatedAt,
  workspace_id: session.workspaceId,
})

const serializeEvent = (event: {
  artifacts: string[]
  body: string
  createdAt: number
  goalId: string
  id: string
  kind: string
  sequence: number
  status: string | null
  workspaceId: string
}) => ({
  artifacts: event.artifacts,
  body: event.body,
  created_at: event.createdAt,
  goal_id: event.goalId,
  id: event.id,
  kind: event.kind,
  sequence: event.sequence,
  status: event.status,
  workspace_id: event.workspaceId,
})

const sendDeliveryError = (
  response: Parameters<RouteDefinition['handler']>[0]['response'],
  error: ExternalGoalDeliveryError
) => {
  sendJson(response, error.statusCode, {
    cursor: error.cursor,
    error: error.message,
    goal_id: error.goalId,
    status: error.status,
  })
}

/**
 * Loopback-only contract for an external Supervisor (including `hive mcp`).
 * The session capability is intentionally denied to tunneled mobile requests.
 */
export const externalGoalRoutes: RouteDefinition[] = [
  route('GET', '/api/external-goals/session', ({ request, response, store }) => {
    if (isRemoteTunnelRequest(request, store)) {
      throw new ForbiddenError('Supervisor token is not available over the remote tunnel')
    }
    sendJson(response, 200, {
      token: store.getSupervisorToken(),
      token_type: 'hiveteam-supervisor',
    })
  }),
  route('GET', '/api/external-goals/workspaces', ({ request, response, store }) => {
    requireExternalController(request, store)
    sendJson(response, 200, { workspaces: store.listExternalGoalWorkspaces() })
  }),
  route(
    'GET',
    '/api/external-goals/workspaces/:workspaceId',
    ({ params, request, response, store }) => {
      requireExternalController(request, store)
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) return
      sendJson(response, 200, store.inspectExternalGoalWorkspace({ workspaceId }))
    }
  ),
  route('POST', '/api/external-goals/start', async ({ request, response, store }) => {
    requireExternalController(request, store)
    const body = await readJsonBody<Record<string, unknown>>(request)
    const workspaceId = requireNonEmptyString(body.workspace_id, 'workspace_id', 200)
    const goal = requireNonEmptyString(body.goal, 'goal')
    const source =
      body.source === undefined
        ? 'hiveteam-mcp'
        : requireNonEmptyString(body.source, 'source', SOURCE_MAX_CHARS)
    const context = optionalContext(body.context)
    const timeoutHintMs = optionalNonNegativeNumber(body.timeout_hint_ms, 'timeout_hint_ms')
    try {
      const result = await store.startExternalGoal({
        ...(context !== undefined ? { context } : {}),
        goal,
        source,
        ...(timeoutHintMs !== undefined ? { timeoutHintMs } : {}),
        workspaceId,
      })
      sendJson(response, 202, {
        cursor: result.cursor,
        events: result.events.map(serializeEvent),
        goal_id: result.goalId,
        ok: true,
        session: serializeSession(result.session),
        status: result.status,
      })
    } catch (error) {
      if (error instanceof ExternalGoalDeliveryError) {
        sendDeliveryError(response, error)
        return
      }
      throw error
    }
  }),
  route('POST', '/api/external-goals/wait', async ({ request, response, store }) => {
    requireExternalController(request, store)
    const body = await readJsonBody<Record<string, unknown>>(request)
    const goalId = requireNonEmptyString(body.goal_id, 'goal_id', 200)
    const cursor = optionalNonNegativeInteger(body.cursor, 'cursor')
    const timeoutMs = optionalNonNegativeNumber(body.timeout_ms, 'timeout_ms')
    const result = await store.waitExternalGoal({
      ...(cursor !== undefined ? { cursor } : {}),
      goalId,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    })
    sendJson(response, 200, {
      cursor: result.cursor,
      events: result.events.map(serializeEvent),
      goal_id: result.goalId,
      status: result.status,
    })
  }),
  route('POST', '/api/external-goals/continue', async ({ request, response, store }) => {
    requireExternalController(request, store)
    const body = await readJsonBody<Record<string, unknown>>(request)
    const goalId = requireNonEmptyString(body.goal_id, 'goal_id', 200)
    const message = requireNonEmptyString(body.message, 'message')
    const context = optionalContext(body.context)
    try {
      const result = await store.continueExternalGoal({
        ...(context !== undefined ? { context } : {}),
        goalId,
        message,
      })
      sendJson(response, 202, {
        cursor: result.cursor,
        event: serializeEvent(result.event),
        ok: true,
        session: serializeSession(result.session),
        status: result.status,
      })
    } catch (error) {
      if (error instanceof ExternalGoalDeliveryError) {
        sendDeliveryError(response, error)
        return
      }
      throw error
    }
  }),
  route('POST', '/api/external-goals/cancel', async ({ request, response, store }) => {
    requireExternalController(request, store)
    const body = await readJsonBody<Record<string, unknown>>(request)
    const goalId = requireNonEmptyString(body.goal_id, 'goal_id', 200)
    const reason = requireNonEmptyString(body.reason, 'reason')
    try {
      const result = await store.cancelExternalGoal({ goalId, reason })
      sendJson(response, 202, {
        cursor: result.cursor,
        event: serializeEvent(result.event),
        ok: true,
        session: serializeSession(result.session),
        status: result.status,
      })
    } catch (error) {
      if (error instanceof ExternalGoalDeliveryError) {
        sendDeliveryError(response, error)
        return
      }
      throw error
    }
  }),
]
