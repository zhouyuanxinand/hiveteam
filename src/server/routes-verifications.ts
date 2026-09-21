import type { DispatchVerificationView } from '../shared/verification.js'
import { BadRequestError } from './http-errors.js'
import { requireLocalUser } from './request-principal.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'
import { serializeVerification as serializeRun } from './verification-dto.js'

const serializeView = (view: DispatchVerificationView) => ({
  isolated: view.isolated ?? false,
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
  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/verification-profiles',
    ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const id = required(params, 'workspaceId')
      store.getWorkspaceSnapshot(id)
      sendJson(response, 200, store.verifications.profiles.list(id))
    }
  ),
  route(
    'POST',
    '/api/ui/workspaces/:workspaceId/verification-profiles',
    async ({ params, request, response, store }) => {
      requireLocalUser(request, store)
      const id = required(params, 'workspaceId')
      store.getWorkspaceSnapshot(id)
      sendJson(response, 201, store.verifications.profiles.save(id, await readJsonBody(request)))
    }
  ),
  route(
    'PUT',
    '/api/ui/workspaces/:workspaceId/verification-profiles/:profileId',
    async ({ params, request, response, store }) => {
      requireLocalUser(request, store)
      const id = required(params, 'workspaceId')
      store.getWorkspaceSnapshot(id)
      store.verifications.profiles.get(id, required(params, 'profileId'))
      sendJson(
        response,
        200,
        store.verifications.profiles.save(
          id,
          await readJsonBody(request),
          required(params, 'profileId')
        )
      )
    }
  ),
  route('GET', `${base}/:verificationId/log`, ({ params, request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const query = new URL(request.url ?? '/', 'http://localhost').searchParams
    sendJson(
      response,
      200,
      store.verifications.readLog(
        required(params, 'workspaceId'),
        required(params, 'dispatchId'),
        required(params, 'verificationId'),
        query.has('offset') ? Number(query.get('offset')) : undefined,
        query.has('limit') ? Number(query.get('limit')) : undefined
      )
    )
  }),
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
      profile_id?: unknown
    }>(request)
    if (
      (typeof body?.command !== 'string' && typeof body?.profile_id !== 'string') ||
      (body.profile_id !== undefined && typeof body.profile_id !== 'string') ||
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
        command: typeof body.command === 'string' ? body.command : '',
        ...(typeof body.profile_id === 'string' ? { profileId: body.profile_id } : {}),
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
