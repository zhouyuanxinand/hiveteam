import { BadRequestError } from './http-errors.js'
import { requireLocalUser } from './request-principal.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const readiness = '/api/ui/workspaces/:workspaceId/agents/:agentId/readiness'
export const onboardingRoutes: RouteDefinition[] = [
  route('GET', readiness, async ({ request, response, store, params }) => {
    requireLocalUser(request, store)
    response.setHeader('Cache-Control', 'no-store')
    sendJson(
      response,
      200,
      await store.cliReadiness.view(params.workspaceId ?? '', params.agentId ?? '')
    )
  }),
  route('POST', readiness, async ({ request, response, store, params }) => {
    requireLocalUser(request, store)
    const body = await readJsonBody<{ expected_cli_fingerprint: string }>(request)
    if (!body || typeof body.expected_cli_fingerprint !== 'string')
      throw new BadRequestError('expected_cli_fingerprint is required')
    response.setHeader('Cache-Control', 'no-store')
    sendJson(
      response,
      200,
      await store.cliReadiness.probe(
        params.workspaceId ?? '',
        params.agentId ?? '',
        body.expected_cli_fingerprint
      )
    )
  }),
  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/onboarding',
    ({ request, response, store, params }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const id = params.workspaceId ?? ''
      store.getWorkspaceSnapshot(id)
      sendJson(response, 200, { initialization: store.onboarding.view(id) })
    }
  ),
  route('GET', '/api/settings/onboarding-metrics', ({ request, response, store }) => {
    requireLocalUser(request, store)
    sendJson(response, 200, {
      workloads: store.onboarding.metrics(),
      model_cost: null,
      model_quality: null,
    })
  }),
]
