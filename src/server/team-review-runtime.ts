import type { TeamReviewRecord, TeamReviewView } from '../shared/team-review.js'
import type { CodeReviewRuntime } from './code-review-runtime.js'
import { BadRequestError, ConflictError, ForbiddenError, HttpError } from './http-errors.js'
import { wrapUntrustedPromptData } from './prompt-safety.js'
import type { RuntimeStoreServices } from './runtime-store-helpers.js'
import { createTeamReviewReader, teamReviewVersion } from './team-review-reader.js'
import { createTeamReviewStore } from './team-review-store.js'
import type { WorkerLifecycleRuntime } from './worker-lifecycle-runtime.js'

export interface TeamReviewRequest {
  request_id: string
  dispatch_id: string
  focus: string
  command_preset_id?: string
}
const validate = (body: TeamReviewRequest) => {
  if (
    !body ||
    typeof body.request_id !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(body.request_id)
  )
    throw new BadRequestError('request_id must be a UUID v4')
  if (
    typeof body.dispatch_id !== 'string' ||
    !body.dispatch_id.trim() ||
    typeof body.focus !== 'string' ||
    !body.focus.trim() ||
    Buffer.byteLength(body.focus, 'utf8') > 8000
  )
    throw new BadRequestError('dispatch_id and review focus (up to 8 KiB) are required')
  if (
    body.command_preset_id !== undefined &&
    (typeof body.command_preset_id !== 'string' || !body.command_preset_id.trim())
  )
    throw new BadRequestError('command_preset_id must be a non-empty string')
  return { ...body, focus: body.focus.trim() }
}
export const createTeamReviewRuntime = (
  services: Pick<
    RuntimeStoreServices,
    | 'db'
    | 'workspaceStore'
    | 'worktrees'
    | 'dispatchLedgerStore'
    | 'agentRuntime'
    | 'settings'
    | 'teamOps'
  >,
  members: WorkerLifecycleRuntime,
  reviews: CodeReviewRuntime
) => {
  const store = createTeamReviewStore(services.db)
  const reader = createTeamReviewReader(services, store, reviews)
  const pending = new Map<string, { fingerprint: string; promise: Promise<TeamReviewView> }>()
  let closing = false
  const settle = () => {
    if (closing) return
    for (const record of store.completed()) {
      try {
        members.dismiss(record.workspace_id, record.reviewer_id)
      } catch (error) {
        if (error instanceof ConflictError) continue
        store.fail(record.id, error instanceof Error ? error.message : String(error))
        console.error('[hive] temporary reviewer retirement failed', {
          requestId: record.id,
          error,
        })
      }
    }
  }
  // Admission and Git preparation can finish before a child dispatch is committed.
  // Preserve that member and its checkout, but do not resume an unassigned reviewer.
  for (const record of store.interrupted()) {
    const worker = services.workspaceStore.getWorker(record.workspace_id, record.reviewer_id)
    const error =
      record.last_error ??
      worker.preparationError ??
      'Review preparation was interrupted before task creation; inspect the retained directory, dismiss this member, and request a new review'
    store.fail(record.id, error)
    services.workspaceStore.finishWorkerPreparation(record.workspace_id, record.reviewer_id, error)
  }
  // A report may have committed immediately before shutdown. Retire its owner
  // before automatic resume can launch it; the report Outbox remains untouched.
  settle()
  const timer = setInterval(settle, 1000)
  timer.unref()
  const create = async (
    workspaceId: string,
    actorId: string,
    body: TeamReviewRequest,
    hivePort: string
  ) => {
    const existing = store.get(body.request_id)
    if (existing) {
      if (
        existing.workspace_id !== workspaceId ||
        existing.requested_by !== actorId ||
        existing.source_dispatch_id !== body.dispatch_id ||
        existing.focus !== body.focus ||
        (body.command_preset_id && existing.command_preset_id !== body.command_preset_id)
      )
        throw new ConflictError('This request_id was already used for another review')
      return reader.view(existing)
    }
    const source = services.dispatchLedgerStore.getDispatchById(workspaceId, body.dispatch_id)
    if (!source) throw new HttpError(404, 'Source dispatch not found')
    if (source.status !== 'reported' || source.reportRevision < 1)
      throw new ConflictError('Wait for the source report before requesting a code review')
    const current = await reviews.view(workspaceId, source.id)
    if (!current.version || current.is_dirty || current.unavailable_reason)
      throw new ConflictError(
        current.unavailable_reason ?? 'Commit source changes before requesting a review'
      )
    const version = current.version
    const policy = members.readPolicy(workspaceId)
    if (!policy.enabled)
      throw new ForbiddenError('Enable dynamic staffing and authorize CLI presets first')
    const sourcePreset = services.agentRuntime.peekAgentLaunchConfig(
      workspaceId,
      source.toAgentId
    )?.commandPresetId
    const available = policy.allowed_command_preset_ids.filter((id) =>
      services.settings.getCommandPreset(id)
    )
    const preset =
      body.command_preset_id ?? available.find((id) => id !== sourcePreset) ?? available[0]
    if (!preset || !available.includes(preset))
      throw new ForbiddenError('Choose an allowed CLI preset for this review')
    let record: TeamReviewRecord | undefined
    try {
      const worker = await members.create(
        workspaceId,
        {
          name: `Review ${body.request_id}`,
          role: 'reviewer',
          command_preset_id: preset,
          description:
            'Review only the assigned committed version, report findings, then retire. Do not edit the source or accept/integrate it.',
          isolated: true,
          autostart: false,
        },
        hivePort,
        actorId,
        {
          pinnedCommit: { headSha: version.source_sha, repositoryId: version.repository_id },
          onCreated: (reviewerId) => {
            const candidate: TeamReviewRecord = {
              id: body.request_id,
              workspace_id: workspaceId,
              source_dispatch_id: source.id,
              source_report_revision: version.report_revision,
              source_head_sha: version.source_sha,
              source_base_sha: version.base_sha,
              repository_id: version.repository_id,
              baseline_kind: current.baseline_kind,
              focus: body.focus,
              command_preset_id: preset,
              requested_by: actorId,
              reviewer_id: reviewerId,
              review_dispatch_id: null,
              created_at: Date.now(),
              last_error: null,
            }
            store.create(candidate)
            record = candidate
          },
        }
      )
      if (!record) throw new Error('Review admission did not persist its owner')
      if (worker.preparation_state === 'failed') {
        store.fail(record.id, worker.preparation_error ?? 'Review checkout preparation failed')
      } else {
        const task = [
          'Review the committed source in this independent checkout. Do not edit files or change HEAD.',
          `Source dispatch: ${source.id}. The assigned source version is fixed: ${JSON.stringify(teamReviewVersion(record))}`,
          `Compare commits ${version.base_sha}..${version.source_sha}; stay within this workspace directory.`,
          'team review context/file returns the assigned snapshot. Never retarget this request after a source change.',
          'You may submit structured review evidence with team review submit using that original version; only an enforced read-only run can do so, and stale versions are rejected.',
          'Always finish this review task with team report --dispatch <YOUR REVIEW DISPATCH ID> --outcome success|failed|blocked|partial. Include findings even if the source has since changed. Do not report against the source dispatch ID.',
          'Report completion will retire this temporary member after its last open task. Evidence and the worktree are retained. Findings do not accept, verify or integrate the source.',
          wrapUntrustedPromptData('review-feedback', body.focus),
        ].join('\n\n')
        await services.teamOps.dispatchTask(workspaceId, worker.id, task, {
          fromAgentId: actorId,
          hivePort,
          parentDispatchId: source.id,
          messageProtocolVersion: 1,
          onCreated: (dispatch) => store.attach(body.request_id, dispatch),
        })
      }
    } catch (error) {
      // Persist preparation/start failures only after durable admission. Failures
      // before admission retain their original HTTP error and roll back the member.
      const admitted = store.get(body.request_id)
      if (!admitted) throw error
      store.fail(admitted.id, error instanceof Error ? error.message : String(error))
    }
    return reader.get(workspaceId, body.request_id)
  }
  return {
    ...reader,
    request(workspaceId: string, actorId: string, input: TeamReviewRequest, hivePort: string) {
      if (closing) throw new ConflictError('Runtime is closing')
      if (services.workspaceStore.getAgent(workspaceId, actorId).role !== 'orchestrator')
        throw new ForbiddenError('Only the Orchestrator can request temporary reviewers')
      const body = validate(input)
      const fingerprint = JSON.stringify([
        workspaceId,
        actorId,
        body.dispatch_id,
        body.focus,
        body.command_preset_id ?? null,
      ])
      const inFlight = pending.get(body.request_id)
      if (inFlight) {
        if (inFlight.fingerprint !== fingerprint)
          throw new ConflictError('This request_id is already preparing a different review')
        return inFlight.promise
      }
      const promise = create(workspaceId, actorId, body, hivePort)
      pending.set(body.request_id, { fingerprint, promise })
      return promise.finally(() => pending.delete(body.request_id))
    },
    async close() {
      closing = true
      clearInterval(timer)
      await Promise.allSettled([...pending.values()].map((item) => item.promise))
    },
  }
}
export type TeamReviewRuntime = ReturnType<typeof createTeamReviewRuntime>
