import type { DispatchVerification, DispatchVerificationView } from '../shared/verification.js'
import { BadRequestError } from './http-errors.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const serializeRun = (run: DispatchVerification) => ({
  id: run.id,
  workspace_id: run.workspaceId,
  dispatch_id: run.dispatchId,
  report_revision: run.reportRevision,
  head_sha: run.headSha,
  command: run.command,
  state: run.state,
  output: run.output,
  output_truncated: run.outputTruncated,
  exit_code: run.exitCode,
  error: run.error,
  started_at: run.startedAt,
  ended_at: run.endedAt,
  accepted_at: run.acceptedAt,
})
const serializeView = (view: DispatchVerificationView) => ({
  head_sha: view.headSha,
  is_dirty: view.isDirty,
  unavailable_reason: view.unavailableReason,
  report_revision: view.reportRevision,
  can_run: view.canRun,
  can_accept: view.canAccept,
  stale_reason: view.staleReason,
  accepted: view.accepted,
  runs: view.runs.map(serializeRun),
})
const base = '/api/ui/workspaces/:workspaceId/dispatches/:dispatchId/verifications'
const required = (params: Record<string, string>, name: string) => {
  const value = params[name]
  if (!value) throw new BadRequestError(`${name} is required`)
  return value
}

export const verificationRoutes: RouteDefinition[] = [
  route('GET', base, async ({ params, request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    sendJson(
      response,
      200,
      serializeView(
        await store.verifications.view(
          required(params, 'workspaceId'),
          required(params, 'dispatchId')
        )
      )
    )
  }),
  route('POST', base, async ({ params, request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const body = await readJsonBody<{
      command?: unknown
      head_sha?: unknown
      report_revision?: unknown
    }>(request)
    if (
      typeof body?.command !== 'string' ||
      typeof body.head_sha !== 'string' ||
      !/^[0-9a-f]{40,64}$/u.test(body.head_sha) ||
      typeof body.report_revision !== 'number' ||
      !Number.isSafeInteger(body.report_revision) ||
      body.report_revision < 1
    ) {
      throw new BadRequestError('command, full head_sha, and positive report_revision are required')
    }
    const run = await store.verifications.start(
      required(params, 'workspaceId'),
      required(params, 'dispatchId'),
      {
        command: body.command,
        headSha: body.head_sha,
        reportRevision: body.report_revision,
      }
    )
    sendJson(response, 202, serializeRun(run))
  }),
  ...(['accept', 'cancel'] as const).map((action) =>
    route(
      'POST',
      `${base}/:verificationId/${action}`,
      async ({ params, request, response, store }) => {
        requireUiTokenFromRequest(request, store.validateUiToken)
        const view = await store.verifications[action](
          required(params, 'workspaceId'),
          required(params, 'dispatchId'),
          required(params, 'verificationId')
        )
        sendJson(response, 200, serializeView(view))
      }
    )
  ),
]
