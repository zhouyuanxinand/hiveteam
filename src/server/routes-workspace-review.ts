import { BadRequestError } from './http-errors.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const root = '/api/workspaces/:workspaceId/review'
const textField = (body: Record<string, unknown>, key: string) => {
  if (typeof body[key] !== 'string') throw new BadRequestError(`${key} must be text`)
  return body[key]
}
const bodyRecord = async (request: Parameters<typeof readJsonBody>[0]) => {
  const body = await readJsonBody<unknown>(request, { limitBytes: 512_000 })
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new BadRequestError('Expected a JSON object')
  return body as Record<string, unknown>
}
const reviewRoute = (method: string, suffix: string, handler: RouteDefinition['handler']) =>
  route(method, root + suffix, (context) => {
    requireUiTokenFromRequest(context.request, context.store.validateUiToken)
    return handler(context)
  })

export const workspaceReviewRoutes: RouteDefinition[] = [
  reviewRoute('GET', '/documents', async ({ params, response, store }) => {
    sendJson(response, 200, await store.review.list(params.workspaceId ?? ''))
  }),
  reviewRoute('GET', '/document', async ({ params, request, response, store }) => {
    const path = new URL(request.url ?? '', 'http://localhost').searchParams.get('path') ?? ''
    sendJson(response, 200, await store.review.read(params.workspaceId ?? '', path))
  }),
  reviewRoute('PUT', '/draft', async ({ params, request, response, store }) => {
    const body = await bodyRecord(request)
    if (typeof body.expected_version !== 'number')
      throw new BadRequestError('expected_version must be a number')
    sendJson(
      response,
      200,
      await store.review.save(params.workspaceId ?? '', {
        path: textField(body, 'path'),
        base_revision: textField(body, 'base_revision'),
        content: textField(body, 'content'),
        note: textField(body, 'note'),
        expected_version: body.expected_version,
      })
    )
  }),
  reviewRoute('POST', '/confirm', async ({ params, request, response, store }) => {
    const body = await bodyRecord(request)
    sendJson(
      response,
      200,
      await store.review.confirm(
        params.workspaceId ?? '',
        textField(body, 'path'),
        textField(body, 'revision')
      )
    )
  }),
  reviewRoute('POST', '/send', async ({ params, request, response, store }) => {
    const body = await bodyRecord(request)
    if (typeof body.draft_version !== 'number')
      throw new BadRequestError('draft_version must be a number')
    sendJson(
      response,
      202,
      await store.review.review(params.workspaceId ?? '', {
        request_id: textField(body, 'request_id'),
        path: textField(body, 'path'),
        draft_version: body.draft_version,
      })
    )
  }),
  reviewRoute('POST', '/answer', async ({ params, request, response, store }) => {
    const body = await bodyRecord(request)
    sendJson(
      response,
      202,
      store.review.answer(params.workspaceId ?? '', {
        request_id: textField(body, 'request_id'),
        text: textField(body, 'text'),
        question: textField(body, 'question'),
        ...(body.agent_id !== undefined ? { agent_id: textField(body, 'agent_id') } : {}),
      })
    )
  }),
  reviewRoute('GET', '/submissions/:requestId', ({ params, response, store }) => {
    sendJson(
      response,
      200,
      store.review.submission(params.workspaceId ?? '', params.requestId ?? '')
    )
  }),
]
