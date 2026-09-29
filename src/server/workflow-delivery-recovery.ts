import type { WorkflowRecoveryIssue, WorkflowRun } from '../shared/workflows.js'
import type { DeliveryRecord } from './message-delivery-store.js'
import type { Database } from './sqlite.js'
import type { createWorkflowRunStore } from './workflow-run-store.js'

export const workflowIsActive = (run: WorkflowRun) =>
  run.status === 'running' || run.status === 'interrupted'

// Inspect only current step bindings. Transport state never creates a dispatch,
// acknowledges a receipt, or substitutes a delivery receipt for cancellation.
export const createWorkflowDeliveryRecovery = (
  db: Database,
  store: ReturnType<typeof createWorkflowRunStore>
) => {
  const delivery = (id: string) =>
    db.prepare('SELECT * FROM message_deliveries WHERE id=?').get(id) as DeliveryRecord | undefined
  const inspect = (run: WorkflowRun): WorkflowRecoveryIssue[] => {
    if (!workflowIsActive(run)) return []
    const issues: WorkflowRecoveryIssue[] = []
    for (const step of run.steps) {
      if (!step.dispatchId || ['completed', 'failed', 'stopped'].includes(step.status)) continue
      const dispatchId = step.dispatchId
      const dispatch = db
        .prepare('SELECT id,status,to_agent_id FROM dispatches WHERE workspace_id=? AND id=?')
        .get(run.workspaceId, step.dispatchId) as
        | { id: string; status: string; to_agent_id: string }
        | undefined
      const add = (
        reason: WorkflowRecoveryIssue['reason'],
        record?: DeliveryRecord,
        detail: string | null = record?.reason ?? null
      ) => {
        issues.push({
          step_id: step.id,
          dispatch_id: record?.dispatch_id ?? dispatchId,
          delivery_id: record?.id ?? null,
          reason,
          detail,
        })
      }
      const blockers = (record: DeliveryRecord) => {
        // This is the same recipient exclusion used by the real delivery claim.
        // A current pending attempt may wait on an older responsibility; expose
        // that receipt's true dispatch_id rather than relabeling its ownership.
        const blocked = db
          .prepare(`SELECT * FROM message_deliveries WHERE workspace_id=?
          AND recipient_id=? AND id<>? AND state IN ('unknown','manual') ORDER BY created_at,id`)
          .all(record.workspace_id, record.recipient_id, record.id) as DeliveryRecord[]
        for (const blocker of blocked)
          add(
            'delivery_blocked',
            blocker,
            `Step ${step.id} is waiting for this recipient's unresolved delivery. ${blocker.reason ?? ''}`.trim()
          )
      }
      if (!dispatch) {
        add(
          'delivery_unavailable',
          undefined,
          'The current dispatch is missing. Review this attempt before rerunning.'
        )
        continue
      }
      if (dispatch.status === 'reported') continue
      if (dispatch.status === 'cancelled') {
        if (!step.rerunPending) {
          add(
            'dispatch_cancelled',
            undefined,
            'This attempt was cancelled. Stop the workflow or explicitly rerun this step.'
          )
          continue
        }
        const health = db
          .prepare(
            'SELECT cancellation_confirmed_at,reasons FROM dispatch_health WHERE dispatch_id=?'
          )
          .get(dispatch.id) as
          | { cancellation_confirmed_at: number | null; reasons: string }
          | undefined
        if (health?.cancellation_confirmed_at != null) continue
        const cancel = db
          .prepare(
            "SELECT * FROM message_deliveries WHERE workspace_id=? AND dispatch_id=? AND kind='cancel' ORDER BY rowid DESC LIMIT 1"
          )
          .get(run.workspaceId, dispatch.id) as DeliveryRecord | undefined
        if (
          !cancel ||
          cancel.state === 'unknown' ||
          cancel.state === 'manual' ||
          (health && (JSON.parse(health.reasons) as string[]).includes('cancellation_unconfirmed'))
        )
          add(
            'cancellation_unconfirmed',
            cancel,
            'Confirm that the previous execution stopped before starting a new attempt.'
          )
        if (cancel?.state === 'pending') blockers(cancel)
        continue
      }
      const record = delivery(dispatch.id)
      if (
        !record ||
        record.kind !== 'dispatch' ||
        record.workspace_id !== run.workspaceId ||
        record.dispatch_id !== dispatch.id ||
        record.recipient_id !== dispatch.to_agent_id
      ) {
        add(
          'delivery_unavailable',
          undefined,
          'The current dispatch has no matching delivery record. Review it before rerunning.'
        )
      } else if (record.state === 'unknown') add('delivery_unknown', record)
      else if (record.state === 'manual') add('delivery_manual', record)
      else if (record.state === 'pending') blockers(record)
      else if (record.state === 'resolved' && record.evidence !== 'manual')
        add(
          'delivery_unavailable',
          record,
          record.reason ??
            'Delivery ended without an acceptance receipt. Stop or rerun this attempt.'
        )
    }
    return issues
  }
  return {
    view(run: WorkflowRun): WorkflowRun {
      return { ...run, recoveryIssues: inspect(run) }
    },
    reconcile(run: WorkflowRun): WorkflowRun {
      if (!workflowIsActive(run)) return { ...run, recoveryIssues: [] }
      const recoveryIssues = inspect(run)
      const status = recoveryIssues.length ? 'interrupted' : 'running'
      const error = recoveryIssues.length
        ? 'Workflow interrupted. Resolve the listed delivery or cancellation before continuing.'
        : run.status === 'interrupted'
          ? null
          : run.error
      if (run.status !== status || run.error !== error)
        store.saveRun(run, { status, error, endedAt: null })
      return { ...(store.get(run.workspaceId, run.id) ?? run), recoveryIssues }
    },
  }
}
