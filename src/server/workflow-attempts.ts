import type { Database } from 'better-sqlite3'
import type { WorkflowRun } from '../shared/workflows.js'
import { BadRequestError, ConflictError } from './http-errors.js'
import type { createWorkflowRunStore } from './workflow-run-store.js'
import type { WorkflowRuntimeInput } from './workflow-runtime.js'
export const createWorkflowAttempts = ({
  db,
  teamOps,
  getDispatch,
  cancellationConfirmed,
  get,
  saveRun,
  schedule,
}: {
  db: Database
  teamOps: WorkflowRuntimeInput['teamOps']
  getDispatch: WorkflowRuntimeInput['getDispatch']
  cancellationConfirmed: WorkflowRuntimeInput['cancellationConfirmed']
  get: ReturnType<typeof createWorkflowRunStore>['get']
  saveRun: ReturnType<typeof createWorkflowRunStore>['saveRun']
  schedule: (id: string) => void
}) => {
  const requireRun = (workspaceId: string, runId: string) => {
    const run = get(workspaceId, runId)
    if (!run) throw new ConflictError('The workflow run was removed.')
    return run
  }
  const affectedSteps = (run: WorkflowRun, stepId: string) => {
    const affected = new Set([stepId])
    for (let changed = true; changed; ) {
      changed = false
      for (const step of run.steps)
        if (!affected.has(step.id) && step.needs.some((id) => affected.has(id))) {
          affected.add(step.id)
          changed = true
        }
    }
    return affected
  }
  const requestRerun = (
    workspaceId: string,
    runId: string,
    stepId: string,
    expectedAttempt: number,
    reason: string,
    acknowledgeExternal = false
  ) => {
    const run = get(workspaceId, runId)
    const selected = run?.steps.find((step) => step.id === stepId)
    if (!run || !selected) throw new BadRequestError('Workflow step not found')
    if (!reason.trim() || reason.length > 4000)
      throw new BadRequestError('A rerun reason of 1–4000 characters is required')
    if (!selected.attempt || run.steps.some((step) => !step.attempt))
      throw new ConflictError(
        'This historical run has no attempt provenance. Start a new workflow run.'
      )
    if (selected.attempt !== expectedAttempt || run.steps.some((step) => step.rerunPending))
      throw new ConflictError(
        'The attempt changed or a rerun is already waiting for cancellation. Refresh this run.'
      )
    const affected = affectedSteps(run, stepId)
    const published = db
      .prepare(`SELECT p.dispatch_id FROM dispatch_pull_requests p
      JOIN workflow_step_attempts a ON a.dispatch_id=p.dispatch_id WHERE a.run_id=?
      AND a.step_id IN (SELECT value FROM json_each(?))`)
      .all(runId, JSON.stringify([...affected]))
    if (published.length && !acknowledgeExternal)
      throw new ConflictError(
        'Affected attempts have external publication records. Review them and explicitly acknowledge that rerunning will not undo those external effects.'
      )
    db.transaction(() => {
      saveRun(run)
      for (const step of run.steps)
        if (affected.has(step.id))
          db.prepare(
            'UPDATE workflow_step_attempts SET invalidated_at=?,reason=? WHERE run_id=? AND step_id=? AND attempt=?'
          ).run(
            Date.now(),
            `${reason}${published.length ? ' [External effects acknowledged; retained.]' : ''}`,
            run.id,
            step.id,
            step.attempt
          )
      saveRun(
        {
          ...run,
          steps: run.steps.map((step) =>
            affected.has(step.id)
              ? {
                  ...step,
                  rerunPending: true,
                  status: 'blocked' as const,
                  resultVersion: null,
                  error: 'Rerun requested. Waiting for affected executions to finish cancellation.',
                }
              : step
          ),
        },
        { status: 'running', endedAt: null, error: null }
      )
    })()
    schedule(run.id)
    return requireRun(workspaceId, runId)
  }
  const settleRerun = (run: WorkflowRun) => {
    const pending = run.steps.filter((step) => step.rerunPending)
    if (!pending.length) return run
    let waiting = false
    for (const step of pending) {
      if (!step.dispatchId) continue
      let dispatch = getDispatch?.(run.workspaceId, step.dispatchId)
      if (dispatch && ['queued', 'submitted', 'failed'].includes(dispatch.status)) {
        teamOps.cancelTask(run.workspaceId, dispatch.id, {
          fromAgentId: `${run.workspaceId}:orchestrator`,
          reason: 'Workflow attempt invalidated by a local rerun.',
        })
        dispatch = getDispatch?.(run.workspaceId, step.dispatchId)
      }
      if (!dispatch || (dispatch.status !== 'reported' && !cancellationConfirmed?.(dispatch.id)))
        waiting = true
    }
    if (waiting) return get(run.workspaceId, run.id) ?? run
    const current = requireRun(run.workspaceId, run.id)
    saveRun({
      ...current,
      steps: current.steps.map((step) =>
        step.rerunPending
          ? {
              ...step,
              attempt: (step.attempt ?? 0) + 1,
              rerunPending: false,
              dispatchId: null,
              needsRerun: false,
              reportText: null,
              artifacts: [],
              error: null,
              status: 'queued' as const,
              resultVersion: null,
              dependencyVersions: {},
              inputVersion: null,
              waitingFor: step.quality?.all_of ?? [],
            }
          : step
      ),
    })
    return requireRun(run.workspaceId, run.id)
  }

  return { affectedSteps, requestRerun, settleRerun }
}
