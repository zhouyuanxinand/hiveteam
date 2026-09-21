import { HttpError } from './http-errors.js'
import { requireLocalUser } from './request-principal.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import {
  describeSessionAdapter,
  isSessionHarness,
  SESSION_HARNESSES,
} from './session-adapter-capabilities.js'
import {
  inspectInstalledSessionAdapter,
  readSessionDiagnostic,
  SessionDiagnosticInputError,
} from './session-adapter-diagnostics.js'

export const sessionAdapterRoutes: RouteDefinition[] = [
  route('GET', '/api/settings/session-adapters', ({ request, response, store }) => {
    requireLocalUser(request, store)
    response.setHeader('cache-control', 'no-store')
    sendJson(
      response,
      200,
      SESSION_HARNESSES.map((harness) =>
        inspectInstalledSessionAdapter(harness, process.cwd(), process.env)
      )
    )
  }),
  route(
    'POST',
    '/api/settings/session-adapters/:harness/diagnose',
    async ({ request, response, store, params }) => {
      requireLocalUser(request, store)
      response.setHeader('cache-control', 'no-store')
      const harness = params.harness ?? ''
      if (!isSessionHarness(harness)) throw new HttpError(404, 'Unknown session adapter')
      let body: unknown
      try {
        body = await readJsonBody<unknown>(request, { limitBytes: 65536 })
      } catch (error) {
        if (error instanceof SyntaxError)
          throw new SessionDiagnosticInputError('Diagnostic body must be valid JSON.')
        throw error
      }
      sendJson(response, 200, describeSessionAdapter(harness, readSessionDiagnostic(harness, body)))
    }
  ),
]
