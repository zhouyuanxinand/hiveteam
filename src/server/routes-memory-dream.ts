import { memoryDreamImpact } from '../shared/memory-dream-plan.js'
import type {
  TeamMemoryDreamReview,
  TeamMemoryDreamRun,
  TeamMemoryDreamSuggestion,
} from '../shared/team-memory.js'
import { BadRequestError, ForbiddenError } from './http-errors.js'
import { parseDreamHistoryQuery } from './memory-dream-history.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const serializeSuggestion = (suggestion: TeamMemoryDreamSuggestion) => ({
  body: suggestion.body,
  kind: suggestion.kind,
  procedure_ref: suggestion.procedureRef,
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
  generation: run.generation,
  created_at: run.createdAt,
  plan_version: run.planVersion,
  plan_revision: run.planRevision,
  operations: run.operations,
  source_snapshots: run.sourceSnapshots,
  change_receipt: run.receipt,
  ...memoryDreamImpact(run.operations),
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

const readDreamRequestBody = async (request: Parameters<typeof readJsonBody>[0]) => {
  const body = await readJsonBody<unknown>(request)
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new BadRequestError('Dream request must be an object')
  return body as Record<string, unknown>
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
  route('GET', '/api/ui/workspaces/:workspaceId/memory/dream/history', (context) => {
    requireUiTokenFromRequest(context.request, context.store.validateUiToken)
    const workspaceId = workspaceIdFrom(context)
    if (!workspaceId) return
    context.store.getWorkspaceSnapshot(workspaceId)
    const query = new URL(context.request.url ?? '/', 'http://127.0.0.1').searchParams
    const page = context.store.memoryDream.history(workspaceId, parseDreamHistoryQuery(query))
    sendJson(context.response, 200, {
      runs: page.runs.map((run) =>
        serializeRun(run, context.store.memoryDream.listReviews(workspaceId, run.id))
      ),
      next_cursor: page.nextCursor,
      review_count: page.reviewCount,
    })
  }),
  route('GET', '/api/ui/workspaces/:workspaceId/memory/dream/:runId', (context) => {
    requireUiTokenFromRequest(context.request, context.store.validateUiToken)
    const workspaceId = workspaceIdFrom(context)
    const runId = dreamIdFrom(context)
    if (!workspaceId || !runId) return
    context.store.getWorkspaceSnapshot(workspaceId)
    const run = context.store.memoryDream.get(workspaceId, runId)
    if (!run) {
      sendJson(context.response, 404, { error: 'Dream run not found' })
      return
    }
    sendJson(
      context.response,
      200,
      serializeRun(run, context.store.memoryDream.listReviews(workspaceId, runId))
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
  route('POST', '/api/ui/workspaces/:workspaceId/memory/dream/generate', async (context) => {
    requireUiTokenFromRequest(context.request, context.store.validateUiToken)
    const workspaceId = workspaceIdFrom(context)
    if (!workspaceId) return
    context.store.getWorkspaceSnapshot(workspaceId)
    const body = await readDreamRequestBody(context.request)
    if (body.retry !== undefined && typeof body.retry !== 'boolean')
      throw new BadRequestError('retry must be a boolean')
    const run = await context.store.requestMemoryDreamGeneration(workspaceId, body.retry === true)
    if (!run) {
      context.response.writeHead(204)
      context.response.end()
      return
    }
    sendJson(context.response, 201, serializeRun(run))
  }),
  route('POST', '/api/ui/workspaces/:workspaceId/memory/dream/:runId/discard', async (context) => {
    requireUiTokenFromRequest(context.request, context.store.validateUiToken)
    const workspaceId = workspaceIdFrom(context)
    const runId = dreamIdFrom(context)
    if (!workspaceId || !runId) return
    const body = await readDreamRequestBody(context.request)
    const run = context.store.memoryDream.discard(workspaceId, runId, body.expected_revision)
    if (!run) {
      sendJson(context.response, 404, { error: 'Dream run not found' })
      return
    }
    sendJson(
      context.response,
      200,
      serializeRun(run, context.store.memoryDream.listReviews(workspaceId, runId))
    )
  }),
  route('PATCH', '/api/ui/workspaces/:workspaceId/memory/dream/:runId', async (context) => {
    requireUiTokenFromRequest(context.request, context.store.validateUiToken)
    const workspaceId = workspaceIdFrom(context)
    const runId = dreamIdFrom(context)
    if (!workspaceId || !runId) return
    const body = await readJsonBody<{ expected_revision?: unknown; operations?: unknown }>(
      context.request
    )
    const updated = context.store.memoryDream.updateOperations(
      workspaceId,
      runId,
      body.expected_revision,
      body.operations
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
    const body = await readJsonBody<{
      orchestrator_id?: unknown
      expected_revision?: unknown
      operations?: unknown
    }>(context.request)
    if (typeof body.orchestrator_id !== 'string' || !body.orchestrator_id.trim()) {
      throw new BadRequestError('orchestrator_id is required')
    }
    const actor = context.store.getAgent(workspaceId, body.orchestrator_id)
    if (actor.role !== 'orchestrator' || actor.id !== `${workspaceId}:orchestrator`) {
      throw new ForbiddenError('Only the Workspace Orchestrator can submit a Dream')
    }
    const updated = context.store.memoryDream.submit(
      workspaceId,
      runId,
      {
        id: actor.id,
        name: actor.name,
      },
      body.expected_revision,
      body.operations
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
