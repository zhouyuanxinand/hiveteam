import type { WorkflowRun, WorkflowRunStep } from '../shared/workflows.js'
import type { DispatchRecord } from './dispatch-ledger-store.js'
import { sanitizePromptData } from './prompt-safety.js'
import { MAX_REPORT_LENGTH } from './workflow-definition.js'
import { workflowIsActive } from './workflow-delivery-recovery.js'
import type { createWorkflowRunStore } from './workflow-run-store.js'

type RunStore = ReturnType<typeof createWorkflowRunStore>

// Reports are durable truth; callback delivery and restart use the same projection.
export const createWorkflowReports = (
  store: RunStore,
  getDispatch: (workspaceId: string, dispatchId: string) => DispatchRecord | undefined
) => {
  const finish = (run: WorkflowRun) => {
    if (workflowIsActive(run) && run.steps.every((step) => step.status === 'completed')) {
      store.saveRun(run, { status: 'completed', error: null, endedAt: Date.now() })
      return store.get(run.workspaceId, run.id) ?? run
    }
    return run
  }
  const apply = (run: WorkflowRun, dispatch: DispatchRecord) => {
    const step = run.steps.find((candidate) => candidate.dispatchId === dispatch.id)
    if (
      !workflowIsActive(run) ||
      dispatch.workspaceId !== run.workspaceId ||
      dispatch.status !== 'reported' ||
      !step ||
      step.rerunPending ||
      step.needsRerun ||
      !['queued', 'running', 'blocked', 'awaiting_review'].includes(step.status)
    )
      return undefined
    const canAdvance = dispatch.reportOutcome === 'success' || dispatch.acceptedAt != null
    const status = step.quality
      ? 'awaiting_review'
      : canAdvance
        ? 'completed'
        : dispatch.reportOutcome
          ? 'blocked'
          : 'awaiting_review'
    const patch = {
      artifacts: dispatch.artifacts.map((artifact) => sanitizePromptData(artifact, 1_000)),
      error:
        status === 'blocked'
          ? `Worker reported ${dispatch.reportOutcome}. Review the report and send feedback to continue.`
          : null,
      reportText: sanitizePromptData(dispatch.reportText ?? '', MAX_REPORT_LENGTH),
      status,
      resultVersion:
        !step.quality && canAdvance
          ? {
              attempt: step.attempt ?? 0,
              dispatch_id: dispatch.id,
              report_revision: dispatch.reportRevision,
              source_sha: null,
              base_sha: null,
              repository_id: null,
            }
          : null,
    } satisfies Partial<WorkflowRunStep>
    if (
      step.status === patch.status &&
      step.error === patch.error &&
      step.reportText === patch.reportText &&
      JSON.stringify(step.artifacts) === JSON.stringify(patch.artifacts) &&
      JSON.stringify(step.resultVersion) === JSON.stringify(patch.resultVersion)
    )
      return finish(run)
    return finish(store.updateStep(run, step.id, patch))
  }
  return {
    record(workspaceId: string, notification: DispatchRecord) {
      const dispatch = getDispatch(workspaceId, notification.id)
      if (
        !dispatch ||
        dispatch.status !== 'reported' ||
        dispatch.reportRevision !== notification.reportRevision
      )
        return undefined
      const run = store.findRunForDispatch(workspaceId, dispatch.id)
      return run ? apply(run, dispatch) : undefined
    },
    refresh(initial: WorkflowRun) {
      let run = initial
      for (const candidate of initial.steps) {
        // Quality evidence is asynchronous and version-bound; its own reconciler owns it.
        if (candidate.quality || !candidate.dispatchId) continue
        const dispatch = getDispatch(initial.workspaceId, candidate.dispatchId)
        if (dispatch) run = apply(run, dispatch) ?? run
      }
      return finish(run)
    },
  }
}
