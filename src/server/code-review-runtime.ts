import type { Database } from 'better-sqlite3'
import {
  type CodeReviewConclusion,
  type CodeReviewRecord,
  type CodeReviewStaleReason,
  type CodeReviewVersion,
  type CodeReviewView,
  sameCodeReviewVersion,
} from '../shared/code-review.js'
import { CodeReviewError } from './code-review-error.js'
import {
  readCodeReviewFile,
  readCodeReviewPatch,
  readCodeReviewVersion,
} from './code-review-git.js'
import { createCodeReviewStore } from './code-review-store.js'
import type { DispatchRecord } from './dispatch-ledger-store.js'
import { BadRequestError, HttpError } from './http-errors.js'
import { validateReviewText } from './workspace-review.js'

export const validateCodeReviewVersion = (value: unknown): CodeReviewVersion => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestError('version is required')
  const fields = value as Record<string, unknown>
  if (
    typeof fields.repository_id !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(fields.repository_id) ||
    typeof fields.source_sha !== 'string' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(fields.source_sha) ||
    typeof fields.base_sha !== 'string' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(fields.base_sha) ||
    typeof fields.report_revision !== 'number' ||
    !Number.isSafeInteger(fields.report_revision) ||
    fields.report_revision < 1
  )
    throw new BadRequestError(
      'version requires repository_id, full source_sha, full base_sha and positive report_revision'
    )
  return {
    repository_id: fields.repository_id,
    source_sha: fields.source_sha,
    base_sha: fields.base_sha,
    report_revision: fields.report_revision,
  }
}

export const createCodeReviewRuntime = (input: {
  db: Database
  getDispatch: (workspaceId: string, dispatchId: string) => DispatchRecord | undefined
  source: (
    workspaceId: string,
    dispatch: DispatchRecord
  ) => { sourcePath: string; targetPath: string; targetBranch?: string }
  assertReviewer: (workspaceId: string, agentId: string) => { runId: string; policyId: string }
  withOperation: <T>(workspaceId: string, operation: () => Promise<T>) => Promise<T>
  onChanged?: (workspaceId: string, dispatchId: string) => void
}) => {
  const store = createCodeReviewStore(input.db)
  const getDispatch = (workspaceId: string, dispatchId: string) => {
    const dispatch = input.getDispatch(workspaceId, dispatchId)
    if (!dispatch) throw new HttpError(404, 'Dispatch not found')
    return dispatch
  }
  const assertReport = (workspaceId: string, dispatchId: string, revision: number) => {
    const current = getDispatch(workspaceId, dispatchId)
    if (current.status !== 'reported' || current.reportRevision !== revision)
      throw new CodeReviewError(
        'review_stale',
        'The report changed. Reload the code review before continuing.'
      )
  }
  const load = async (workspaceId: string, dispatchId: string) => {
    const dispatch = getDispatch(workspaceId, dispatchId)
    const state = await readCodeReviewVersion({
      ...input.source(workspaceId, dispatch),
      reportRevision: dispatch.reportRevision,
      dispatchBase: dispatch.baseHeadSha,
    })
    const latest = getDispatch(workspaceId, dispatchId)
    if (latest.status !== 'reported' || latest.reportRevision !== dispatch.reportRevision)
      state.unavailable_reason = 'Wait for the current task report, then reload the code review.'
    return state
  }
  const requireCurrent = async (
    workspaceId: string,
    dispatchId: string,
    expected: CodeReviewVersion
  ) => {
    const current = await load(workspaceId, dispatchId)
    if (current.unavailable_reason)
      throw new CodeReviewError('review_unavailable', current.unavailable_reason)
    if (!current.version || current.is_dirty || !sameCodeReviewVersion(current.version, expected))
      throw new CodeReviewError(
        'review_stale',
        'Code, baseline, repository or report changed. Reload and review the current version.'
      )
    return current
  }
  const viewFor = (
    workspaceId: string,
    dispatchId: string,
    current: Awaited<ReturnType<typeof load>>
  ): CodeReviewView => {
    const records = store.list(workspaceId, dispatchId)
    const reviews = records.map((record, index) => {
      const version = current.version
      const reason: CodeReviewStaleReason | null = !version
        ? 'unavailable'
        : record.repository_id !== version.repository_id
          ? 'repository_changed'
          : record.report_revision !== version.report_revision
            ? 'report_changed'
            : record.source_sha !== version.source_sha
              ? 'code_changed'
              : record.base_sha !== version.base_sha
                ? 'baseline_changed'
                : current.is_dirty
                  ? 'uncommitted_changes'
                  : current.unavailable_reason
                    ? 'unavailable'
                    : index > 0
                      ? 'superseded'
                      : null
      return {
        ...record,
        stale_reason: reason,
        can_accept: !reason && record.conclusion === 'approve' && record.accepted_at === null,
      }
    })
    return {
      version: current.version,
      baseline_kind: current.baseline_kind,
      is_dirty: current.is_dirty,
      unavailable_reason: current.unavailable_reason,
      reviews,
      accepted: reviews[0]?.stale_reason === null && reviews[0]?.accepted_at != null,
    }
  }
  const view = async (workspaceId: string, dispatchId: string) =>
    viewFor(workspaceId, dispatchId, await load(workspaceId, dispatchId))
  return {
    view,
    async context(workspaceId: string, dispatchId: string) {
      const current = await load(workspaceId, dispatchId)
      return {
        ...viewFor(workspaceId, dispatchId, current),
        ...(await readCodeReviewPatch(current)),
      }
    },
    async file(
      workspaceId: string,
      dispatchId: string,
      version: CodeReviewVersion,
      path: string,
      side: 'source' | 'base'
    ) {
      return readCodeReviewFile(await requireCurrent(workspaceId, dispatchId, version), path, side)
    },
    submit(
      workspaceId: string,
      dispatchId: string,
      reviewerId: string,
      request: {
        request_id: string
        version: CodeReviewVersion
        conclusion: CodeReviewConclusion
        summary: string
      }
    ) {
      if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
          request.request_id
        )
      )
        throw new BadRequestError('request_id must be a UUID v4')
      if (!['approve', 'changes_requested', 'comment'].includes(request.conclusion))
        throw new BadRequestError('Unknown review conclusion')
      const summary = validateReviewText(request.summary, 'summary', 16000).trim()
      if (!summary) throw new BadRequestError('A review summary is required')
      validateCodeReviewVersion(request.version)
      return input
        .withOperation(workspaceId, async () => {
          const actor =
            reviewerId === 'local_user' ? null : input.assertReviewer(workspaceId, reviewerId)
          const existing = store.get(request.request_id)
          if (existing) {
            if (
              existing.workspace_id !== workspaceId ||
              existing.dispatch_id !== dispatchId ||
              existing.reviewer_id !== reviewerId ||
              !sameCodeReviewVersion(existing, request.version) ||
              existing.conclusion !== request.conclusion ||
              existing.summary !== summary
            )
              throw new CodeReviewError(
                'review_stale',
                'This review request ID was already used with different content.'
              )
            return existing
          }
          await requireCurrent(workspaceId, dispatchId, request.version)
          const record: CodeReviewRecord = {
            ...request.version,
            id: request.request_id,
            workspace_id: workspaceId,
            dispatch_id: dispatchId,
            reviewer_id: reviewerId,
            reviewer_run_id: actor?.runId ?? null,
            reviewer_policy_id: actor?.policyId ?? null,
            conclusion: request.conclusion,
            summary,
            created_at: Date.now(),
            accepted_at: null,
            accepted_by: null,
          }
          input.db.transaction(() => {
            assertReport(workspaceId, dispatchId, request.version.report_revision)
            if (actor) {
              const currentActor = input.assertReviewer(workspaceId, reviewerId)
              if (currentActor.runId !== actor.runId || currentActor.policyId !== actor.policyId)
                throw new CodeReviewError(
                  'review_read_only_required',
                  'The reviewer execution changed. Review again in its current run.',
                  403
                )
            }
            store.insert(record)
          })()
          return record
        })
        .then((record) => {
          input.onChanged?.(workspaceId, dispatchId)
          return record
        })
    },
    accept(workspaceId: string, dispatchId: string, reviewId: string, expected: CodeReviewVersion) {
      validateCodeReviewVersion(expected)
      return input
        .withOperation(workspaceId, async () => {
          await requireCurrent(workspaceId, dispatchId, expected)
          input.db.transaction(() => {
            assertReport(workspaceId, dispatchId, expected.report_revision)
            const latest = store.list(workspaceId, dispatchId)[0]
            if (
              !latest ||
              latest.id !== reviewId ||
              !sameCodeReviewVersion(latest, expected) ||
              latest.conclusion !== 'approve'
            )
              throw new CodeReviewError(
                'review_superseded',
                'Only the latest approving review of this version can be accepted.'
              )
            store.accept(reviewId)
          })()
          return view(workspaceId, dispatchId)
        })
        .then((current) => {
          input.onChanged?.(workspaceId, dispatchId)
          return current
        })
    },
  }
}

export type CodeReviewRuntime = ReturnType<typeof createCodeReviewRuntime>
