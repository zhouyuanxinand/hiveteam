import { isClarificationSkill } from '../shared/clarification.js'
import {
  type ClarificationRequestRecord,
  createClarificationRequestStore,
} from './clarification-request-store.js'
import { BadRequestError, ConflictError, ForbiddenError } from './http-errors.js'
import type { RuntimeStoreServices } from './runtime-store-helpers.js'
import type { WorkerLifecycleRuntime } from './worker-lifecycle-runtime.js'

export interface ClarificationRequest {
  request_id: string
  text: string
  skill_name: string
}
const validate = (body: ClarificationRequest) => {
  if (
    !body ||
    typeof body.request_id !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(body.request_id)
  )
    throw new BadRequestError('request_id must be a UUID v4')
  if (typeof body.text !== 'string' || !body.text.trim() || Buffer.byteLength(body.text) > 32000)
    throw new BadRequestError('Interview text must contain 1-32000 bytes')
  if (typeof body.skill_name !== 'string' || !isClarificationSkill(body.skill_name))
    throw new BadRequestError(
      'team grill requires a grill, grilling, grill-me or grill-with-docs Skill'
    )
  return { ...body, text: body.text.trim(), skill_name: body.skill_name.trim() }
}
export const createClarificationRuntime = (
  services: Pick<
    RuntimeStoreServices,
    | 'db'
    | 'workspaceStore'
    | 'teamOps'
    | 'teamSkillRuntime'
    | 'dispatchLedgerStore'
    | 'dispatchSkillActivationStore'
    | 'agentRuntime'
  >,
  members: WorkerLifecycleRuntime
) => {
  const requests = createClarificationRequestStore(services.db)
  // Serialize selection as well as creation: two requests must never reserve the same idle member.
  const pending = new Map<string, Promise<unknown>>()
  let closing = false
  const view = (record: ClarificationRequestRecord) => {
    const dispatch = record.dispatch_id
      ? services.dispatchLedgerStore.getDispatchById(record.workspace_id, record.dispatch_id)
      : undefined
    const worker = services.workspaceStore
      .getWorkspaceSnapshot(record.workspace_id)
      .agents.find((member) => member.id === record.worker_id)
    const ok = Boolean(
      worker && dispatch && ['queued', 'submitted', 'reported'].includes(dispatch.status)
    )
    return {
      ok,
      request_id: record.id,
      worker_id: record.worker_id,
      worker_name: worker?.name ?? null,
      created: record.created_worker === 1,
      dispatch_id: record.dispatch_id,
      status: dispatch?.status ?? 'failed',
      ...(!ok
        ? {
            error: !worker
              ? 'The interview member was deleted; this request cannot create a replacement'
              : (record.last_error ??
                'Interview handoff did not complete; inspect the existing task before retrying'),
          }
        : {}),
    }
  }
  const handoff = async (
    workspaceId: string,
    actorId: string,
    body: ClarificationRequest,
    hivePort: string
  ) => {
    if (closing) throw new ConflictError('Runtime is closing')
    let record = requests.get(body.request_id)
    if (record) {
      if (
        record.workspace_id !== workspaceId ||
        record.requested_by !== actorId ||
        record.text !== body.text ||
        record.skill_name !== body.skill_name
      )
        throw new ConflictError('This request_id was already used for another interview')
      if (record.dispatch_id) return view(record)
    }
    // Resolve the immutable Skill before admitting a member; the body is never returned to the main agent.
    const skill = await services.teamSkillRuntime.resolveDispatchActivation(
      workspaceId,
      actorId,
      body.skill_name
    )
    if (!record) {
      const workspace = services.workspaceStore.getWorkspaceSnapshot(workspaceId)
      let workerId: string | undefined
      for (const worker of workspace.agents) {
        if (
          worker.role === 'orchestrator' ||
          worker.retiredAt !== undefined ||
          worker.preparationState ||
          worker.status === 'working' ||
          worker.pendingTaskCount > 0 ||
          services.workspaceStore.isAgentManuallyStopped(workspaceId, worker.id) ||
          services.dispatchLedgerStore.findOpenDispatch(workspaceId, worker.id) ||
          requests.reserved(workspaceId, worker.id) ||
          !services.agentRuntime.peekAgentLaunchConfig(workspaceId, worker.id)
        )
          continue
        const prior = services.dispatchSkillActivationStore.clarificationForWorker(
          workspaceId,
          worker.id
        )
        const catalog = prior
          ? []
          : await services.teamSkillRuntime.listAvailable(workspaceId, worker.id)
        if (
          prior ||
          catalog.some((item) => item.qualifiedName === `${skill.packName}/${skill.skillName}`)
        ) {
          workerId = worker.id
          break
        }
      }
      const reserve = (id: string, created: boolean) => {
        const candidate: ClarificationRequestRecord = {
          id: body.request_id,
          workspace_id: workspaceId,
          requested_by: actorId,
          text: body.text,
          skill_name: body.skill_name,
          worker_id: id,
          created_worker: created ? 1 : 0,
          dispatch_id: null,
          last_error: null,
          created_at: Date.now(),
        }
        requests.create(candidate)
        record = candidate
      }
      if (workerId) services.db.transaction(() => reserve(workerId, false)).immediate()
      else
        await members.createClarification(workspaceId, actorId, hivePort, (id) => reserve(id, true))
    }
    if (!record) throw new Error('Interview admission did not persist its owner')
    if (!services.workspaceStore.hasAgent(workspaceId, record.worker_id)) return view(record)
    try {
      await services.teamOps.dispatchTask(workspaceId, record.worker_id, body.text, {
        fromAgentId: actorId,
        hivePort,
        skillName: body.skill_name,
        startStoppedClarification: true,
        onCreated: (dispatch) => requests.attach(body.request_id, dispatch),
      })
    } catch (error) {
      // Keep the admitted owner and any committed dispatch so retries cannot create duplicates.
      requests.fail(record.id, error instanceof Error ? error.message : String(error))
    }
    const persisted = requests.get(record.id)
    if (!persisted) throw new Error('Interview request disappeared')
    return view(persisted)
  }
  return {
    request(workspaceId: string, actorId: string, input: ClarificationRequest, hivePort: string) {
      if (closing) throw new ConflictError('Runtime is closing')
      if (services.workspaceStore.getAgent(workspaceId, actorId).role !== 'orchestrator')
        throw new ForbiddenError('Only the Orchestrator can hand off a grill interview')
      const body = validate(input)
      const previous = pending.get(workspaceId) ?? Promise.resolve()
      const run = () => handoff(workspaceId, actorId, body, hivePort)
      // Failure of a previous independent request must not poison the workspace queue.
      const operation = previous.then(run, run)
      pending.set(workspaceId, operation)
      return operation.finally(() => {
        if (pending.get(workspaceId) === operation) pending.delete(workspaceId)
      })
    },
    async close() {
      closing = true
      await Promise.allSettled(pending.values())
    },
  }
}
export type ClarificationRuntime = ReturnType<typeof createClarificationRuntime>
