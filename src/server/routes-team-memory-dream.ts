import { BadRequestError, ConflictError, ForbiddenError, HttpError } from './http-errors.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { authenticateCliAgent } from './team-authz.js'

const text = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new BadRequestError(`${field} is required`)
  return value.trim()
}
const integer = (value: unknown, fallback: number, minimum: number, maximum: number) => {
  if (value === undefined) return fallback
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new BadRequestError('Invalid Dream input pagination')
  return value
}

export const teamMemoryDreamRoutes: RouteDefinition[] = ['input', 'result', 'fail'].map((action) =>
  route('POST', `/api/team/dream/${action}`, async ({ request, response, store }) => {
    const body = await readJsonBody<Record<string, unknown>>(request).catch((error: unknown) => {
      if (error instanceof SyntaxError)
        throw new BadRequestError('Dream request must contain valid JSON')
      throw error
    })
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestError('Dream request must be an object')
    const workspaceId = text(body.project_id, 'project_id')
    const dreamId = text(body.dream_id, 'dream_id')
    const actor = authenticateCliAgent({
      request,
      workspaceId,
      fromAgentId: text(body.from_agent_id, 'from_agent_id'),
      token: typeof body.token === 'string' ? body.token : undefined,
      getAgent: store.getAgent,
      validateToken: store.validateAgentToken,
    })
    const run = store.memoryDream.get(workspaceId, dreamId)
    if (!run) throw new HttpError(404, 'Dream run not found')
    if (action === 'input') {
      const section = body.section ?? 'generation'
      const offset = integer(body.offset, 0, 0, Number.MAX_SAFE_INTEGER)
      const limit = integer(body.limit, 5, 1, 10)
      const generation = run.generation
      let items: unknown[]
      if (section === 'operations') items = run.operations
      else if (section === 'sources') items = run.sourceSnapshots
      else if (section === 'generation') {
        if (!generation) throw new ConflictError('This Dream has no protocol generation input')
        items = [
          ...generation.input.messages.map((message) => ({
            source_type: 'protocol_message',
            ...message,
          })),
          ...generation.input.memories.map((memory) => ({ source_type: 'memory', ...memory })),
        ]
      } else throw new BadRequestError('section must be generation, operations, or sources')
      sendJson(response, 200, {
        dream_id: run.id,
        plan_revision: run.planRevision,
        section,
        offset,
        total: items.length,
        next_offset: offset + limit < items.length ? offset + limit : null,
        items: items.slice(offset, offset + limit),
        ...(generation
          ? {
              input_hash: generation.input_hash,
              attempt_id: generation.attempt_id,
              generation_status: generation.status,
              input_window: { from: generation.input.from, to: generation.input.to },
            }
          : {}),
      })
      return
    }
    if (actor.role !== 'orchestrator' || actor.id !== `${workspaceId}:orchestrator`)
      throw new ForbiddenError('Only the Workspace Orchestrator can return Dream candidates')
    const active = store.getActiveRunByAgentId(workspaceId, actor.id)
    if (!active)
      throw new ConflictError('Start the Workspace Orchestrator before returning Dream candidates')
    const attemptId = text(body.attempt_id, 'attempt_id')
    if (action === 'fail') {
      if (
        run.generation?.run_id !== active.runId ||
        run.generation.attempt_id !== attemptId ||
        run.generation.status !== 'requested'
      )
        throw new ConflictError('This Dream attempt is no longer active')
      store.memoryDreamGeneration.fail(workspaceId, dreamId, attemptId, text(body.error, 'error'))
      sendJson(response, 200, { dream_id: dreamId, generation_status: 'failed' })
      return
    }
    const inputHash = text(body.input_hash, 'input_hash')
    if (!/^[a-f0-9]{64}$/.test(inputHash))
      throw new BadRequestError('input_hash must be a SHA-256 hash')
    const completed = store.memoryDreamGeneration.complete(
      workspaceId,
      dreamId,
      active.runId,
      attemptId,
      inputHash,
      body.result
    )
    sendJson(response, 200, {
      dream_id: completed.id,
      plan_revision: completed.planRevision,
      generation_status: completed.generation?.status,
      candidate_count: completed.generation?.candidate_count,
      status: completed.status,
    })
  })
)
