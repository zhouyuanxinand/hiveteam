import {
  isTeamMemoryKind,
  isTeamMemoryScope,
  isTeamMemoryStatus,
  TEAM_MEMORY_BODY_MAX_CHARS,
  type TeamMemoryEntry,
  type TeamMemoryKind,
  type TeamMemoryScope,
} from '../shared/team-memory.js'
import { BadRequestError } from './http-errors.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { isWorkspaceMemoryEnabled, setWorkspaceMemoryEnabled } from './team-memory-digest.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const serializeMemory = (entry: TeamMemoryEntry) => ({
  body: entry.body,
  confidence: entry.confidence,
  created_at: entry.createdAt,
  created_by_agent_id: entry.createdByAgentId,
  created_by_agent_name: entry.createdByAgentName,
  disabled: entry.disabled,
  id: entry.id,
  kind: entry.kind,
  last_injected_at: entry.lastInjectedAt,
  pinned: entry.pinned,
  scope: entry.scope,
  source: entry.source,
  status: entry.status,
  tags: entry.tags,
  updated_at: entry.updatedAt,
  workspace_id: entry.workspaceId,
})

const requireWorkspaceId = (context: Parameters<RouteDefinition['handler']>[0]): string | null => {
  const workspaceId = getRequiredParam(
    context.response,
    context.params,
    'workspaceId',
    'Workspace id is required'
  )
  if (workspaceId) context.store.getWorkspaceSnapshot(workspaceId)
  return workspaceId
}

const requireMemoryId = (context: Parameters<RouteDefinition['handler']>[0]) =>
  getRequiredParam(context.response, context.params, 'memoryId', 'Memory id is required')

const parseQueryOptions = (requestUrl: string | undefined) => {
  const url = new URL(requestUrl ?? '/', 'http://127.0.0.1')
  const statusValue = url.searchParams.get('status')
  const scopeValue = url.searchParams.get('scope')
  const rawLimit = Number(url.searchParams.get('limit') ?? '')
  return {
    ...(statusValue && isTeamMemoryStatus(statusValue) ? { status: statusValue } : {}),
    ...(scopeValue && isTeamMemoryScope(scopeValue) ? { scope: scopeValue } : {}),
    ...(Number.isFinite(rawLimit) && rawLimit > 0 ? { limit: rawLimit } : {}),
    ...(url.searchParams.get('query') ? { query: url.searchParams.get('query') ?? '' } : {}),
  }
}

type CreateMemoryBody = {
  body?: unknown
  kind?: unknown
  scope?: unknown
  tags?: unknown
}

const validateMemoryBody = (value: string) => {
  if (!value.trim()) throw new BadRequestError('Memory body must not be empty')
  if (value.trim().length > TEAM_MEMORY_BODY_MAX_CHARS) {
    throw new BadRequestError(
      `Memory body must be ${TEAM_MEMORY_BODY_MAX_CHARS} characters or fewer`
    )
  }
}

const readCreateBody = async (request: Parameters<RouteDefinition['handler']>[0]['request']) => {
  const body = await readJsonBody<CreateMemoryBody>(request)
  if (typeof body.body !== 'string') throw new BadRequestError('Memory body is required')
  validateMemoryBody(body.body)
  if (!isTeamMemoryKind(body.kind)) throw new BadRequestError('Invalid memory kind')
  if (body.scope !== undefined && !isTeamMemoryScope(body.scope)) {
    throw new BadRequestError('Invalid memory scope')
  }
  if (body.tags !== undefined && !Array.isArray(body.tags)) {
    throw new BadRequestError('Memory tags must be an array')
  }
  const tags = (body.tags ?? []).filter((tag): tag is string => typeof tag === 'string')
  return {
    body: body.body,
    kind: body.kind,
    ...(body.scope ? { scope: body.scope } : {}),
    tags,
  }
}

type PatchMemoryBody = {
  body?: unknown
  disabled?: unknown
  kind?: unknown
  pinned?: unknown
  scope?: unknown
  status?: unknown
  tags?: unknown
}

const readPatchBody = async (request: Parameters<RouteDefinition['handler']>[0]['request']) => {
  const body = await readJsonBody<PatchMemoryBody>(request)
  if (body.body !== undefined && typeof body.body !== 'string') {
    throw new BadRequestError('Memory body must be a string')
  }
  if (typeof body.body === 'string') validateMemoryBody(body.body)
  if (body.kind !== undefined && !isTeamMemoryKind(body.kind)) {
    throw new BadRequestError('Invalid memory kind')
  }
  if (body.scope !== undefined && !isTeamMemoryScope(body.scope)) {
    throw new BadRequestError('Invalid memory scope')
  }
  if (body.status !== undefined && !isTeamMemoryStatus(body.status)) {
    throw new BadRequestError('Invalid memory status')
  }
  for (const key of ['disabled', 'pinned'] as const) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean') {
      throw new BadRequestError(`${key} must be a boolean`)
    }
  }
  if (body.tags !== undefined && !Array.isArray(body.tags)) {
    throw new BadRequestError('Memory tags must be an array')
  }
  return {
    ...(typeof body.body === 'string' ? { body: body.body } : {}),
    ...(typeof body.disabled === 'boolean' ? { disabled: body.disabled } : {}),
    ...(isTeamMemoryKind(body.kind) ? { kind: body.kind as TeamMemoryKind } : {}),
    ...(typeof body.pinned === 'boolean' ? { pinned: body.pinned } : {}),
    ...(isTeamMemoryScope(body.scope) ? { scope: body.scope as TeamMemoryScope } : {}),
    ...(isTeamMemoryStatus(body.status) ? { status: body.status } : {}),
    ...(Array.isArray(body.tags)
      ? { tags: body.tags.filter((tag): tag is string => typeof tag === 'string') }
      : {}),
  }
}

export const workspaceMemoryRoutes: RouteDefinition[] = [
  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/memory',
    ({ request, response, store, ...rest }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const workspaceId = requireWorkspaceId({ request, response, store, ...rest })
      if (!workspaceId) return
      sendJson(
        response,
        200,
        store.memory.list(workspaceId, parseQueryOptions(request.url)).map(serializeMemory)
      )
    }
  ),
  route('POST', '/api/ui/workspaces/:workspaceId/memory', async (context) => {
    requireUiTokenFromRequest(context.request, context.store.validateUiToken)
    const workspaceId = requireWorkspaceId(context)
    if (!workspaceId) return
    sendJson(
      context.response,
      201,
      serializeMemory(
        context.store.memory.create(workspaceId, await readCreateBody(context.request))
      )
    )
  }),
  route('PATCH', '/api/ui/workspaces/:workspaceId/memory/:memoryId', async (context) => {
    requireUiTokenFromRequest(context.request, context.store.validateUiToken)
    const workspaceId = requireWorkspaceId(context)
    const memoryId = requireMemoryId(context)
    if (!workspaceId || !memoryId) return
    const entry = context.store.memory.update(
      workspaceId,
      memoryId,
      await readPatchBody(context.request)
    )
    if (!entry) {
      sendJson(context.response, 404, { error: 'Memory entry not found' })
      return
    }
    sendJson(context.response, 200, serializeMemory(entry))
  }),
  route('GET', '/api/ui/workspaces/:workspaceId/memory/settings', (context) => {
    requireUiTokenFromRequest(context.request, context.store.validateUiToken)
    const workspaceId = requireWorkspaceId(context)
    if (!workspaceId) return
    sendJson(context.response, 200, {
      enabled: isWorkspaceMemoryEnabled(context.store.settings, workspaceId),
    })
  }),
  route('PUT', '/api/ui/workspaces/:workspaceId/memory/settings', async (context) => {
    requireUiTokenFromRequest(context.request, context.store.validateUiToken)
    const workspaceId = requireWorkspaceId(context)
    if (!workspaceId) return
    const body = await readJsonBody<{ enabled?: unknown }>(context.request)
    if (typeof body.enabled !== 'boolean') throw new BadRequestError('enabled must be a boolean')
    setWorkspaceMemoryEnabled(context.store.settings, workspaceId, body.enabled)
    sendJson(context.response, 200, { enabled: body.enabled })
  }),
]
