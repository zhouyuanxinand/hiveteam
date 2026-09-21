import type { IntegrationCandidateView } from '../shared/integration-candidate.js'
import { validateCodeReviewVersion } from './code-review-runtime.js'
import { BadRequestError } from './http-errors.js'
import { requireLocalUser } from './request-principal.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'
import { serializeVerification } from './verification-dto.js'

const required = (params: Record<string, string>, key: string) => {
  const value = params[key]
  if (!value) throw new BadRequestError(`${key} is required`)
  return value
}
const base = '/api/ui/workspaces/:workspaceId/dispatches/:dispatchId/integration-candidates'
const serializeView = (view: IntegrationCandidateView) => ({
  ...view,
  verification: view.verification ? serializeVerification(view.verification) : null,
})
const text = (body: Record<string, unknown>, field: string) => {
  const value = body[field]
  if (typeof value !== 'string' || !value) throw new BadRequestError(`${field} is required`)
  return value
}
export const integrationCandidateRoutes: RouteDefinition[] = [
  route('GET', base, ({ request, response, params, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    sendJson(
      response,
      200,
      store.candidates.list(required(params, 'workspaceId'), required(params, 'dispatchId'))
    )
  }),
  route('GET', `${base}/:candidateId`, async ({ request, response, params, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    sendJson(
      response,
      200,
      serializeView(
        await store.candidates.view(
          required(params, 'workspaceId'),
          required(params, 'dispatchId'),
          required(params, 'candidateId')
        )
      )
    )
  }),
  route('POST', base, async ({ request, response, params, store }) => {
    requireLocalUser(request, store)
    const body = await readJsonBody<{ version?: unknown }>(request)
    sendJson(
      response,
      202,
      await store.candidates.prepare(
        required(params, 'workspaceId'),
        required(params, 'dispatchId'),
        validateCodeReviewVersion(body.version)
      )
    )
  }),
  ...(['continue', 'verify', 'review', 'accept', 'integrate', 'abandon'] as const).map((action) =>
    route(
      'POST',
      `${base}/:candidateId/${action}`,
      async ({ request, response, params, store }) => {
        requireLocalUser(request, store)
        const body = await readJsonBody<Record<string, unknown>>(request)
        const args = [
          required(params, 'workspaceId'),
          required(params, 'dispatchId'),
          required(params, 'candidateId'),
        ] as const
        const result =
          action === 'continue'
            ? serializeView(await store.candidates.continue(...args))
            : action === 'abandon'
              ? store.candidates.abandon(...args)
              : action === 'verify'
                ? serializeVerification(
                    await store.candidates.verify(
                      ...args,
                      text(body, 'candidate_sha'),
                      text(body, 'profile_id')
                    )
                  )
                : action === 'review'
                  ? serializeView(
                      await store.candidates.review(
                        ...args,
                        text(body, 'candidate_sha'),
                        text(body, 'note')
                      )
                    )
                  : action === 'accept'
                    ? serializeView(
                        await store.candidates.accept(
                          ...args,
                          text(body, 'candidate_sha'),
                          text(body, 'verification_id')
                        )
                      )
                    : serializeView(
                        await store.candidates.integrate(
                          ...args,
                          text(body, 'candidate_sha'),
                          text(body, 'target_sha'),
                          text(body, 'verification_id')
                        )
                      )
        sendJson(response, action === 'verify' ? 202 : 200, result)
      }
    )
  ),
]
