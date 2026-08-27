import {
  isTeamMemoryKind,
  isTeamMemoryScope,
  type TeamMemoryDreamReview,
  type TeamMemoryDreamRun,
  type TeamMemoryDreamSuggestion,
} from '../shared/team-memory.js'
import { BadRequestError, ForbiddenError } from './http-errors.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const serializeSuggestion = (suggestion: TeamMemoryDreamSuggestion) => ({
  body: suggestion.body,
  kind: suggestion.kind,
  scope: suggestion.scope,
  source_memory_ids: suggestion.sourceMemoryIds,
  tags: suggestion.tags,
})

const serializeReview = (review: TeamMemoryDreamReview) => ({
  artifacts: review.artifacts,
  created_at: review.createdAt,
  dispatch_id: review.dispatchId,
  dream_id: review.dreamId,
  id: review.id,
  review_text: review.reviewText,
  status: review.status,
  suggestions: review.suggestions.map(serializeSuggestion),
  updated_at: review.updatedAt,
  worker_id: review.workerId,
  workspace_id: review.workspaceId,
})

const serializeRun = (run: TeamMemoryDreamRun, reviews: TeamMemoryDreamReview[] = []) => ({
  created_at: run.createdAt,
  created_memory_ids: run.createdMemoryIds,
  execution_error: run.executionError,
  execution_status: run.executionStatus,
  id: run.id,
  orchestrator_run_id: run.orchestratorRunId,
  rolled_back_at: run.rolledBackAt,
  reviews: reviews.map(serializeReview),
  status: run.status,
  submitted_at: run.submittedAt,
  suggestions: run.suggestions.map(serializeSuggestion),
  workspace_id: run.workspaceId,
})

const workspaceIdFrom = (context: Parameters<RouteDefinition['handler']>[0]) =>
  getRequiredParam(context.response, context.params, 'workspaceId', 'Workspace id is required')

const dreamIdFrom = (context: Parameters<RouteDefinition['handler']>[0]) =>
  getRequiredParam(context.response, context.params, 'runId', 'Dream run id is required')

const normalizeSuggestions = (value: unknown): TeamMemoryDreamSuggestion[] => {
  if (!Array.isArray(value)) throw new BadRequestError('suggestions must be an array')
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new BadRequestError('Invalid Dream suggestion')
    const record = item as Record<string, unknown>
    if (typeof record.body !== 'string' || !record.body.trim()) {
      throw new BadRequestError('Dream suggestion body must not be empty')
    }
    if (!isTeamMemoryKind(record.kind)) throw new BadRequestError('Invalid Dream suggestion kind')
    if (!isTeamMemoryScope(record.scope))
      throw new BadRequestError('Invalid Dream suggestion scope')
    const sourceMemoryIds = Array.isArray(record.source_memory_ids)
      ? record.source_memory_ids.filter((id): id is string => typeof id === 'string')
      : []
    const tags = Array.isArray(record.tags)
      ? record.tags.filter((tag): tag is string => typeof tag === 'string')
      : []
    return {
      body: record.body,
      kind: record.kind,
      scope: record.scope,
      sourceMemoryIds,
      tags,
    }
  })
}

export const memoryDreamRoutes: RouteDefinition[] = [
  route('GET', '/api/ui/workspaces/:workspaceId/memory/dream', (context) => {
    requireUiTokenFromRequest(context.request, context.store.validateUiToken)
    const workspaceId = workspaceIdFrom(context)
    if (!workspaceId) return
    context.store.getWorkspaceSnapshot(workspaceId)
    sendJson(
      context.response,
      200,
      context.store.memoryDream
        .list(workspaceId)
        .map((run) => serializeRun(run, context.store.memoryDream.listReviews(workspaceId, run.id)))
    )
  }),
  route('POST', '/api/ui/workspaces/:workspaceId/memory/dream', async (context) => {
    requireUiTokenFromRequest(context.request, context.store.validateUiToken)
    const workspaceId = workspaceIdFrom(context)
    if (!workspaceId) return
    context.store.getWorkspaceSnapshot(workspaceId)
    sendJson(
      context.response,
      201,
      serializeRun(await context.store.requestMemoryDream(workspaceId))
    )
  }),
  route('PATCH', '/api/ui/workspaces/:workspaceId/memory/dream/:runId', async (context) => {
    requireUiTokenFromRequest(context.request, context.store.validateUiToken)
    const workspaceId = workspaceIdFrom(context)
    const runId = dreamIdFrom(context)
    if (!workspaceId || !runId) return
    const body = await readJsonBody<{ suggestions?: unknown }>(context.request)
    const updated = context.store.memoryDream.updateSuggestions(
      workspaceId,
      runId,
      normalizeSuggestions(body.suggestions)
    )
    if (!updated) {
      sendJson(context.response, 404, { error: 'Dream run not found' })
      return
    }
    sendJson(
      context.response,
      200,
      serializeRun(updated, context.store.memoryDream.listReviews(workspaceId, updated.id))
    )
  }),
  route('GET', '/api/ui/workspaces/:workspaceId/memory/dream/:runId/reviews', (context) => {
    requireUiTokenFromRequest(context.request, context.store.validateUiToken)
    const workspaceId = workspaceIdFrom(context)
    const runId = dreamIdFrom(context)
    if (!workspaceId || !runId) return
    if (!context.store.memoryDream.get(workspaceId, runId)) {
      sendJson(context.response, 404, { error: 'Dream run not found' })
      return
    }
    sendJson(
      context.response,
      200,
      context.store.memoryDream.listReviews(workspaceId, runId).map(serializeReview)
    )
  }),
  route('POST', '/api/ui/workspaces/:workspaceId/memory/dream/:runId/reviews', async (context) => {
    requireUiTokenFromRequest(context.request, context.store.validateUiToken)
    const workspaceId = workspaceIdFrom(context)
    const runId = dreamIdFrom(context)
    if (!workspaceId || !runId) return
    const body = await readJsonBody<{ worker_id?: unknown }>(context.request)
    if (typeof body.worker_id !== 'string' || !body.worker_id.trim()) {
      throw new BadRequestError('worker_id is required')
    }
    const review = await context.store.requestMemoryDreamWorkerReview(
      workspaceId,
      runId,
      body.worker_id,
      String(context.request.socket.localPort ?? '')
    )
    sendJson(context.response, 201, serializeReview(review))
  }),
  route('POST', '/api/ui/workspaces/:workspaceId/memory/dream/:runId/submit', async (context) => {
    requireUiTokenFromRequest(context.request, context.store.validateUiToken)
    const workspaceId = workspaceIdFrom(context)
    const runId = dreamIdFrom(context)
    if (!workspaceId || !runId) return
    const body = await readJsonBody<{ orchestrator_id?: unknown }>(context.request)
    if (typeof body.orchestrator_id !== 'string' || !body.orchestrator_id.trim()) {
      throw new BadRequestError('orchestrator_id is required')
    }
    const actor = context.store.getAgent(workspaceId, body.orchestrator_id)
    if (actor.role !== 'orchestrator' || actor.id !== `${workspaceId}:orchestrator`) {
      throw new ForbiddenError('Only the Workspace Orchestrator can submit a Dream')
    }
    const updated = context.store.memoryDream.submit(workspaceId, runId, {
      id: actor.id,
      name: actor.name,
    })
    if (!updated) {
      sendJson(context.response, 404, { error: 'Dream run not found' })
      return
    }
    sendJson(
      context.response,
      200,
      serializeRun(updated, context.store.memoryDream.listReviews(workspaceId, updated.id))
    )
  }),
  route('POST', '/api/ui/workspaces/:workspaceId/memory/dream/:runId/rollback', (context) => {
    requireUiTokenFromRequest(context.request, context.store.validateUiToken)
    const workspaceId = workspaceIdFrom(context)
    const runId = dreamIdFrom(context)
    if (!workspaceId || !runId) return
    const updated = context.store.memoryDream.rollback(workspaceId, runId)
    if (!updated) {
      sendJson(context.response, 404, { error: 'Dream run not found' })
      return
    }
    sendJson(
      context.response,
      200,
      serializeRun(updated, context.store.memoryDream.listReviews(workspaceId, updated.id))
    )
  }),
]
