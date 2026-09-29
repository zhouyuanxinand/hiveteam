import { join } from 'node:path'
import type { WorkflowCatalogItem, WorkflowRun, WorkflowRunStep } from '../shared/workflows.js'
import { BadRequestError } from './http-errors.js'
import { requireLocalUser } from './request-principal.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const required = (params: Record<string, string>, key: string) => {
  const value = params[key]
  if (!value) throw new BadRequestError(`${key} is required`)
  return value
}
const workspaceIdFrom = (context: Parameters<RouteDefinition['handler']>[0]) =>
  getRequiredParam(context.response, context.params, 'workspaceId', 'Workspace id is required')

const serializeWorkflow = (workflow: WorkflowCatalogItem) => ({
  description: workflow.description,
  id: workflow.id,
  name: workflow.name,
  path: workflow.path,
  runnable: workflow.runnable,
  updated_at: workflow.updatedAt,
  ...(workflow.validationError ? { validation_error: workflow.validationError } : {}),
})

const serializeStep = (step: WorkflowRunStep) => ({
  artifacts: step.artifacts,
  dispatch_id: step.dispatchId,
  error: step.error,
  id: step.id,
  needs: step.needs,
  report_text: step.reportText,
  status: step.status,
  task: step.task,
  worker: step.worker,
  quality: step.quality ?? null,
  waiting_for: step.waitingFor ?? [],
  attempt: step.attempt ?? 0,
  input_version: step.inputVersion ?? null,
  dependency_versions: step.dependencyVersions ?? {},
  result_version: step.resultVersion ?? null,
  rerun_pending: step.rerunPending ?? false,
  needs_rerun: step.needsRerun ?? false,
})
const serializeRun = (run: WorkflowRun) => ({
  created_at: run.createdAt,
  ended_at: run.endedAt,
  error: run.error,
  id: run.id,
  name: run.name,
  started_at: run.startedAt,
  status: run.status,
  recovery_issues: run.recoveryIssues ?? [],
  needs_attention: run.status === 'interrupted' || !!run.recoveryIssues?.length,
  steps: run.steps.map(serializeStep),
  updated_at: run.updatedAt,
  workflow_id: run.workflowId,
  workspace_id: run.workspaceId,
})

const getWorkflowRoot = (context: Parameters<RouteDefinition['handler']>[0]) => {
  const workspaceId = workspaceIdFrom(context)
  if (!workspaceId) return null
  const workspace = context.store.getWorkspaceSnapshot(workspaceId).summary
  return { workspace, workspaceId, workflowRoot: join(workspace.path, '.hive', 'workflows') }
}

export const workflowRoutes: RouteDefinition[] = [
  route(
    'POST',
    '/api/ui/workspaces/:workspaceId/workflows/runs/:runId/steps/:stepId/rerun',
    async ({ request, response, params, store }) => {
      requireLocalUser(request, store)
      const body = await readJsonBody<{
        expected_attempt?: unknown
        reason?: unknown
        acknowledge_external_effects?: unknown
      }>(request)
      if (
        !Number.isSafeInteger(body.expected_attempt) ||
        typeof body.reason !== 'string' ||
        (body.acknowledge_external_effects !== undefined &&
          typeof body.acknowledge_external_effects !== 'boolean')
      )
        throw new BadRequestError(
          'expected_attempt, reason and an optional boolean acknowledge_external_effects are required'
        )
      sendJson(
        response,
        202,
        serializeRun(
          store.workflows.rerun(
            required(params, 'workspaceId'),
            required(params, 'runId'),
            required(params, 'stepId'),
            body.expected_attempt as number,
            body.reason,
            body.acknowledge_external_effects === true
          )
        )
      )
    }
  ),
  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/workflows/runs/:runId/attempts',
    ({ request, response, params, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      sendJson(
        response,
        200,
        store.workflows
          .attempts(required(params, 'workspaceId'), required(params, 'runId'))
          .map((entry) => ({ ...entry, snapshot: serializeStep(entry.snapshot) }))
      )
    }
  ),
  route('GET', '/api/ui/workspaces/:workspaceId/workflows', async (context) => {
    requireUiTokenFromRequest(context.request, context.store.validateUiToken)
    const resolved = getWorkflowRoot(context)
    if (!resolved) return
    const workflows = await context.store.workflows.listCatalog(
      resolved.workflowRoot,
      resolved.workspace.path
    )
    sendJson(context.response, 200, {
      runs: context.store.workflows.listRuns(resolved.workspaceId).map(serializeRun),
      schedules: [],
      workflows: workflows.map(serializeWorkflow),
    })
  }),
  route('GET', '/api/ui/workspaces/:workspaceId/workflows/runs', (context) => {
    requireUiTokenFromRequest(context.request, context.store.validateUiToken)
    const resolved = getWorkflowRoot(context)
    if (!resolved) return
    sendJson(
      context.response,
      200,
      context.store.workflows.listRuns(resolved.workspaceId).map(serializeRun)
    )
  }),
  route('POST', '/api/ui/workspaces/:workspaceId/workflows/runs', async (context) => {
    requireUiTokenFromRequest(context.request, context.store.validateUiToken)
    const resolved = getWorkflowRoot(context)
    if (!resolved) return
    const body = await readJsonBody<{ workflow_id?: unknown }>(context.request)
    if (typeof body.workflow_id !== 'string' || !body.workflow_id.trim()) {
      throw new BadRequestError('workflow_id is required')
    }
    const run = await context.store.workflows.start(
      resolved.workspaceId,
      resolved.workflowRoot,
      body.workflow_id,
      String(context.request.socket.localPort ?? '')
    )
    sendJson(context.response, 201, serializeRun(run))
  }),
  route('GET', '/api/ui/workspaces/:workspaceId/workflows/runs/:runId', async (context) => {
    requireUiTokenFromRequest(context.request, context.store.validateUiToken)
    const workspaceId = workspaceIdFrom(context)
    const runId = getRequiredParam(
      context.response,
      context.params,
      'runId',
      'Workflow run id is required'
    )
    if (!workspaceId || !runId) return
    const run = context.store.workflows.get(workspaceId, runId)
    if (!run) {
      sendJson(context.response, 404, { error: 'Workflow run not found' })
      return
    }
    sendJson(context.response, 200, serializeRun(run))
  }),
  route('POST', '/api/ui/workspaces/:workspaceId/workflows/runs/:runId/stop', async (context) => {
    requireUiTokenFromRequest(context.request, context.store.validateUiToken)
    const workspaceId = workspaceIdFrom(context)
    const runId = getRequiredParam(
      context.response,
      context.params,
      'runId',
      'Workflow run id is required'
    )
    if (!workspaceId || !runId) return
    const run = await context.store.workflows.stop(workspaceId, runId)
    if (!run) {
      sendJson(context.response, 404, { error: 'Workflow run not found' })
      return
    }
    sendJson(context.response, 200, serializeRun(run))
  }),
]
