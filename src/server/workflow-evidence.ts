import type { WorkflowCondition } from '../shared/workflows.js'
import type { CodeReviewRuntime } from './code-review-runtime.js'
import type { DispatchRecord } from './dispatch-ledger-store.js'
import type { VerificationRuntime } from './verification-runtime.js'

export const createWorkflowEvidenceReader =
  (reviews: CodeReviewRuntime, verifications: VerificationRuntime) =>
  async (workspaceId: string, dispatch: DispatchRecord, conditions: WorkflowCondition[]) => {
    const satisfied: WorkflowCondition[] = []
    if (dispatch.status === 'reported' && dispatch.reportOutcome === 'success')
      satisfied.push('report_success')
    const review = conditions.includes('review_accepted')
      ? await reviews.view(workspaceId, dispatch.id)
      : null
    const verification = conditions.includes('verification_passed')
      ? await verifications.view(workspaceId, dispatch.id)
      : null
    if (review?.accepted && review.version?.report_revision === dispatch.reportRevision)
      satisfied.push('review_accepted')
    if (
      verification &&
      !verification.unavailableReason &&
      !verification.staleReason &&
      !verification.isDirty &&
      verification.runs[0]?.state === 'passed' &&
      verification.reportRevision === dispatch.reportRevision
    )
      satisfied.push('verification_passed')
    if (review?.version && verification && review.version.source_sha !== verification.headSha)
      return {
        satisfied: [] as WorkflowCondition[],
        version: { source_sha: null, base_sha: null, repository_id: null },
        reason: 'Code changed while checking quality conditions. Refresh the evidence.',
      }
    return {
      satisfied,
      version: {
        source_sha: review?.version?.source_sha ?? verification?.headSha ?? null,
        base_sha: review?.version?.base_sha ?? null,
        repository_id: review?.version?.repository_id ?? null,
      },
      reason: review?.unavailable_reason ?? verification?.unavailableReason ?? null,
    }
  }
