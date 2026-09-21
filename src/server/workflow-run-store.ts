import type { Database } from 'better-sqlite3'
import type { WorkflowRun, WorkflowRunStep } from '../shared/workflows.js'
import { sanitizePromptData } from './prompt-safety.js'
import { MAX_REPORT_LENGTH, MAX_TASK_LENGTH, MAX_WORKFLOW_STEPS } from './workflow-definition.js'
export interface WorkflowRunRow {
  created_at: number
  definition_json: string
  ended_at: number | null
  error: string | null
  hive_port: string
  id: string
  name: string
  started_at: number | null
  status: WorkflowRun['status']
  steps_json: string
  updated_at: number
  workflow_id: string
  workspace_id: string
}

const parseJson = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

const fromRow = (row: WorkflowRunRow): WorkflowRun => ({
  createdAt: row.created_at,
  endedAt: row.ended_at,
  error: row.error,
  id: row.id,
  name: sanitizePromptData(row.name, 100),
  startedAt: row.started_at,
  status: row.status,
  steps: parseJson<WorkflowRunStep[]>(row.steps_json, []).map((step) => ({
    ...(step.quality ? { quality: step.quality } : {}),
    waitingFor: step.waitingFor ?? [],
    attempt: step.attempt ?? 0,
    inputVersion: step.inputVersion ?? null,
    dependencyVersions: step.dependencyVersions ?? {},
    resultVersion: step.resultVersion ?? null,
    rerunPending: step.rerunPending ?? false,
    needsRerun: step.needsRerun ?? false,
    artifacts: Array.isArray(step.artifacts)
      ? step.artifacts
          .filter((artifact): artifact is string => typeof artifact === 'string')
          .map((artifact) => sanitizePromptData(artifact, 1_000))
      : [],
    dispatchId: typeof step.dispatchId === 'string' ? step.dispatchId : null,
    error: typeof step.error === 'string' ? sanitizePromptData(step.error, 1_000) : null,
    id: sanitizePromptData(step.id, 100),
    needs: Array.isArray(step.needs)
      ? step.needs
          .filter((need): need is string => typeof need === 'string')
          .slice(0, MAX_WORKFLOW_STEPS)
      : [],
    reportText:
      typeof step.reportText === 'string'
        ? sanitizePromptData(step.reportText, MAX_REPORT_LENGTH)
        : null,
    status: step.status,
    task: sanitizePromptData(step.task, MAX_TASK_LENGTH),
    worker: sanitizePromptData(step.worker, 100),
  })),
  updatedAt: row.updated_at,
  workflowId: row.workflow_id,
  workspaceId: row.workspace_id,
})

export const createWorkflowRunStore = (db: Database) => {
  const get = (workspaceId: string, runId: string) => {
    const row = db
      .prepare('SELECT * FROM workflow_runs WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, runId) as WorkflowRunRow | undefined
    return row ? fromRow(row) : undefined
  }

  const listRuns = (workspaceId: string, limit = 20) =>
    (
      db
        .prepare(
          `SELECT * FROM workflow_runs
           WHERE workspace_id = ?
           ORDER BY created_at DESC
           LIMIT ?`
        )
        .all(workspaceId, Math.max(1, Math.min(50, Math.floor(limit)))) as WorkflowRunRow[]
    ).map(fromRow)

  const findRunForDispatch = (workspaceId: string, dispatchId: string) => {
    const row = db
      .prepare(
        `SELECT * FROM workflow_runs
       WHERE workspace_id = ? AND status IN ('running', 'completed')
         AND EXISTS (SELECT 1 FROM json_each(steps_json) step
                     WHERE json_extract(step.value, '$.dispatchId') = ?)
       LIMIT 1`
      )
      .get(workspaceId, dispatchId) as WorkflowRunRow | undefined
    return row ? fromRow(row) : undefined
  }

  const saveRun = (
    run: WorkflowRun,
    patch: { error?: string | null; status?: WorkflowRun['status']; endedAt?: number | null } = {}
  ) => {
    const now = Date.now()
    const status = patch.status ?? run.status
    const endedAt = patch.endedAt === undefined ? run.endedAt : patch.endedAt
    db.transaction(() => {
      db.prepare(
        `UPDATE workflow_runs
       SET steps_json = ?, status = ?, error = ?, ended_at = ?, updated_at = ?
       WHERE workspace_id = ? AND id = ?`
      ).run(
        JSON.stringify(run.steps),
        status,
        patch.error === undefined ? run.error : patch.error,
        endedAt,
        now,
        run.workspaceId,
        run.id
      )
      for (const step of run.steps) {
        if (!step.attempt) continue
        db.prepare(`INSERT INTO workflow_step_attempts(run_id,step_id,attempt,dispatch_id,snapshot)
        VALUES(?,?,?,?,?) ON CONFLICT(run_id,step_id,attempt) DO UPDATE SET
        dispatch_id=excluded.dispatch_id,snapshot=excluded.snapshot WHERE invalidated_at IS NULL`).run(
          run.id,
          step.id,
          step.attempt,
          step.dispatchId,
          JSON.stringify(step)
        )
      }
    })()
  }

  const updateStep = (run: WorkflowRun, stepId: string, patch: Partial<WorkflowRunStep>) => {
    const nextSteps = run.steps.map((step) => (step.id === stepId ? { ...step, ...patch } : step))
    const next = { ...run, steps: nextSteps, updatedAt: Date.now() }
    saveRun(next)
    return get(run.workspaceId, run.id) ?? next
  }

  return { get, listRuns, findRunForDispatch, saveRun, updateStep }
}
