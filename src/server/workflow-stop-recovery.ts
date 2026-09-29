import type { WorkflowRun } from '../shared/workflows.js'
import { ConflictError } from './http-errors.js'
import type { Database } from './sqlite.js'
import type { createWorkflowRunStore } from './workflow-run-store.js'
import type { WorkflowRuntimeInput } from './workflow-runtime.js'

// A stopped step's current binding records cancellation intent. Completed steps
// are excluded: later explicit feedback on their reports is separate work.
const pendingStops = `FROM workflow_runs r, json_each(r.steps_json) step
  JOIN dispatches d ON d.id=json_extract(step.value, '$.dispatchId') AND d.workspace_id=r.workspace_id
  WHERE r.status='stopped' AND json_extract(step.value, '$.status')='stopped'
    AND d.status IN ('queued', 'submitted')`

export const createWorkflowStopRecovery = (
  db: Database,
  store: ReturnType<typeof createWorkflowRunStore>,
  teamOps: WorkflowRuntimeInput['teamOps']
) => {
  const reconcile = (workspaceId: string, runId: string) => {
    const pending = db.prepare(
      `SELECT DISTINCT d.id ${pendingStops} AND r.workspace_id=? AND r.id=?`
    )
    for (const dispatch of pending.all(workspaceId, runId) as { id: string }[]) {
      try {
        teamOps.cancelTask(workspaceId, dispatch.id, {
          fromAgentId: `${workspaceId}:orchestrator`,
          reason: 'Workflow run stopped by the user.',
        })
      } catch (error) {
        // Only an already-closed responsibility makes a cancellation conflict obsolete.
        if (
          error instanceof ConflictError &&
          !(pending.all(workspaceId, runId) as { id: string }[]).some(
            (row) => row.id === dispatch.id
          )
        )
          continue
        throw error
      }
    }
  }
  return {
    reconcile,
    pending(workspaceId?: string) {
      return db
        .prepare(
          `SELECT DISTINCT r.id, r.workspace_id ${pendingStops}${workspaceId ? ' AND r.workspace_id=?' : ''}`
        )
        .all(...(workspaceId ? [workspaceId] : [])) as { id: string; workspace_id: string }[]
    },
    stop(workspaceId: string, runId: string) {
      const run = store.get(workspaceId, runId)
      if (!run || run.status === 'completed' || run.status === 'failed') return run
      if (run.status !== 'stopped') {
        const stopped: WorkflowRun = {
          ...run,
          status: 'stopped',
          steps: run.steps.map((step) =>
            ['completed', 'failed', 'stopped'].includes(step.status)
              ? step
              : {
                  ...step,
                  status: 'stopped',
                  error: step.status === 'running' ? 'Stopped by user.' : null,
                }
          ),
        }
        // Commit intent before cancellation performs persistent and in-memory effects.
        store.saveRun(stopped, { endedAt: Date.now() })
      }
      reconcile(workspaceId, runId)
      return store.get(workspaceId, runId)
    },
  }
}
