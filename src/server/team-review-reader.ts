import { relative } from 'node:path'
import type { CodeReviewVersion } from '../shared/code-review.js'
import { sameCodeReviewVersion } from '../shared/code-review.js'
import type { TeamReviewRecord, TeamReviewView } from '../shared/team-review.js'
import {
  readCodeReviewFile,
  readCodeReviewPatch,
  readCodeReviewRepositoryId,
} from './code-review-git.js'
import type { CodeReviewRuntime } from './code-review-runtime.js'
import { ConflictError, ForbiddenError, HttpError } from './http-errors.js'
import type { RuntimeStoreServices } from './runtime-store-helpers.js'
import type { createTeamReviewStore } from './team-review-store.js'
import { readVerificationVersion } from './verification-worktree.js'

export const teamReviewVersion = (record: TeamReviewRecord): CodeReviewVersion => ({
  repository_id: record.repository_id,
  source_sha: record.source_head_sha,
  base_sha: record.source_base_sha,
  report_revision: record.source_report_revision,
})
export const createTeamReviewReader = (
  services: Pick<RuntimeStoreServices, 'workspaceStore' | 'worktrees' | 'dispatchLedgerStore'>,
  store: ReturnType<typeof createTeamReviewStore>,
  reviews: CodeReviewRuntime
) => {
  const view = async (
    record: TeamReviewRecord,
    knownVersion?: Awaited<ReturnType<CodeReviewRuntime['view']>>
  ): Promise<TeamReviewView> => {
    const current =
      knownVersion ?? (await reviews.view(record.workspace_id, record.source_dispatch_id))
    const source = services.dispatchLedgerStore.getDispatchById(
      record.workspace_id,
      record.source_dispatch_id
    )
    const version = current.version
    const stale: TeamReviewView['stale_reason'] =
      source?.status !== 'reported' || source.reportRevision !== record.source_report_revision
        ? 'report_changed'
        : !version
          ? 'unavailable'
          : version.repository_id !== record.repository_id
            ? 'repository_changed'
            : version.source_sha !== record.source_head_sha
              ? 'code_changed'
              : version.base_sha !== record.source_base_sha
                ? 'baseline_changed'
                : current.is_dirty
                  ? 'uncommitted_changes'
                  : current.unavailable_reason
                    ? 'unavailable'
                    : null
    const worker = services.workspaceStore.getWorker(record.workspace_id, record.reviewer_id)
    const tree = services.worktrees.get(record.workspace_id, record.reviewer_id)
    const checkout =
      tree?.state === 'ready' ? await readVerificationVersion(tree.workspacePath) : null
    const dispatch = record.review_dispatch_id
      ? services.dispatchLedgerStore.getDispatchById(record.workspace_id, record.review_dispatch_id)
      : undefined
    return {
      ...record,
      state:
        dispatch?.status ??
        (worker.preparationState === 'failed' || record.last_error
          ? 'failed'
          : worker.retiredAt !== undefined
            ? 'cancelled'
            : 'preparing'),
      last_error: dispatch?.lastError ?? worker.preparationError ?? record.last_error,
      stale_reason: stale,
      reviewer_retired_at: worker.retiredAt ?? null,
      working_directory: tree?.workspacePath ?? null,
      worktree_dirty: checkout?.repoRoot ? checkout.isDirty : null,
      worktree_error:
        tree?.error ??
        checkout?.unavailableReason ??
        (checkout && checkout.headSha !== record.source_head_sha
          ? 'Review checkout HEAD changed; inspect and retain its files.'
          : null),
      report_text: dispatch?.reportText ?? null,
      report_outcome: dispatch?.reportOutcome ?? null,
      report_revision: dispatch?.reportRevision ?? 0,
      artifacts: dispatch?.artifacts ?? [],
    }
  }
  const binding = (workspaceId: string, workerId: string, dispatchId: string) => {
    const record = store.forReviewer(workspaceId, workerId)
    if (record && record.source_dispatch_id !== dispatchId)
      throw new ForbiddenError('This temporary reviewer is bound to a different source dispatch')
    return record
  }
  const snapshot = async (record: TeamReviewRecord, expected?: CodeReviewVersion) => {
    const version = teamReviewVersion(record)
    if (expected && !sameCodeReviewVersion(expected, version))
      throw new ConflictError('Use the original version assigned to this temporary reviewer')
    const tree = services.worktrees.get(record.workspace_id, record.reviewer_id)
    if (!tree || tree.pinnedHeadSha !== record.source_head_sha)
      throw new ConflictError('The pinned review checkout is unavailable')
    await services.worktrees.validate(tree)
    if ((await readCodeReviewRepositoryId(tree.checkoutPath)) !== record.repository_id)
      throw new ConflictError('The review repository changed')
    return {
      version,
      repoRoot: tree.checkoutPath,
      relativePath: relative(tree.checkoutPath, tree.workspacePath).replaceAll('\\', '/'),
      baseline_kind: record.baseline_kind,
      is_dirty: false,
      unavailable_reason: null,
    }
  }
  return {
    view,
    async get(workspaceId: string, requestId: string) {
      const record = store.get(requestId)
      if (!record || record.workspace_id !== workspaceId)
        throw new HttpError(404, 'Review request not found')
      return view(record)
    },
    async list(workspaceId: string, dispatchId: string) {
      if (!services.dispatchLedgerStore.getDispatchById(workspaceId, dispatchId))
        throw new HttpError(404, 'Dispatch not found')
      const records = store.list(workspaceId, dispatchId)
      if (!records.length) return []
      const current = await reviews.view(workspaceId, dispatchId)
      return Promise.all(records.map((record) => view(record, current)))
    },
    async context(workspaceId: string, workerId: string, dispatchId: string) {
      const record = binding(workspaceId, workerId, dispatchId)
      if (!record) return null
      const current = await snapshot(record)
      return {
        ...current,
        repoRoot: undefined,
        relativePath: undefined,
        reviews: [],
        accepted: false,
        review_request_id: record.id,
        source_stale_reason: (await view(record)).stale_reason,
        ...(await readCodeReviewPatch(current)),
      }
    },
    async file(
      workspaceId: string,
      workerId: string,
      dispatchId: string,
      expected: CodeReviewVersion,
      path: string,
      side: 'source' | 'base'
    ) {
      const record = binding(workspaceId, workerId, dispatchId)
      return record ? readCodeReviewFile(await snapshot(record, expected), path, side) : null
    },
    async assertSubmission(
      workspaceId: string,
      workerId: string,
      dispatchId: string,
      expected: CodeReviewVersion
    ) {
      const record = binding(workspaceId, workerId, dispatchId)
      if (record) await snapshot(record, expected)
    },
  }
}
