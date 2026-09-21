import type { CodeReviewConclusion } from '../shared/code-review.js'
import { validateCodeReviewVersion } from './code-review-runtime.js'
import { BadRequestError } from './http-errors.js'
import { requireLocalUser } from './request-principal.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { authenticateCliAgent, requireCommandForRole } from './team-authz.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const text = (body: Record<string, unknown>, name: string) => {
  const value = body[name]
  if (typeof value !== 'string' || !value.trim()) throw new BadRequestError(`${name} is required`)
  return value
}
const readBody = async (request: Parameters<typeof readJsonBody>[0]) => {
  const body = await readJsonBody<unknown>(request, { limitBytes: 24000 })
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new BadRequestError('Expected an object')
  return body as Record<string, unknown>
}
const submission = (body: Record<string, unknown>) => ({
  request_id: text(body, 'request_id'),
  version: validateCodeReviewVersion(body.version),
  conclusion: text(body, 'conclusion') as CodeReviewConclusion,
  summary: text(body, 'summary'),
})
const base = '/api/ui/workspaces/:workspaceId/dispatches/:dispatchId/reviews'

export const codeReviewRoutes: RouteDefinition[] = [
  route('GET', base, async ({ params, request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    sendJson(
      response,
      200,
      await store.codeReviews.view(params.workspaceId ?? '', params.dispatchId ?? '')
    )
  }),
  route('GET', `${base}/context`, async ({ params, request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    sendJson(
      response,
      200,
      await store.codeReviews.context(params.workspaceId ?? '', params.dispatchId ?? '')
    )
  }),
  route('POST', base, async ({ params, request, response, store }) => {
    requireLocalUser(request, store)
    const body = await readBody(request)
    sendJson(
      response,
      201,
      await store.codeReviews.submit(
        params.workspaceId ?? '',
        params.dispatchId ?? '',
        'local_user',
        submission(body)
      )
    )
  }),
  route('POST', `${base}/:reviewId/accept`, async ({ params, request, response, store }) => {
    requireLocalUser(request, store)
    const body = await readBody(request)
    sendJson(
      response,
      200,
      await store.codeReviews.accept(
        params.workspaceId ?? '',
        params.dispatchId ?? '',
        params.reviewId ?? '',
        validateCodeReviewVersion(body.version)
      )
    )
  }),
  ...(['context', 'file', 'submit'] as const).map((action) =>
    route('POST', `/api/team/review/${action}`, async ({ request, response, store }) => {
      const body = await readBody(request)
      const workspaceId = text(body, 'project_id')
      const dispatchId = text(body, 'dispatch_id')
      const agent = authenticateCliAgent({
        request,
        workspaceId,
        fromAgentId: text(body, 'from_agent_id'),
        token: typeof body.token === 'string' ? body.token : undefined,
        getAgent: store.getAgent,
        validateToken: store.validateAgentToken,
      })
      requireCommandForRole(agent, 'review')
      if (action === 'context')
        sendJson(response, 200, await store.codeReviews.context(workspaceId, dispatchId))
      else if (action === 'file') {
        if (body.side !== 'source' && body.side !== 'base')
          throw new BadRequestError('side must be source or base')
        sendJson(
          response,
          200,
          await store.codeReviews.file(
            workspaceId,
            dispatchId,
            validateCodeReviewVersion(body.version),
            text(body, 'path'),
            body.side
          )
        )
      } else
        sendJson(
          response,
          201,
          await store.codeReviews.submit(workspaceId, dispatchId, agent.id, submission(body))
        )
    })
  ),
]
