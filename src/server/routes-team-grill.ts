import type { ClarificationRequest } from './clarification-runtime.js'
import { BadRequestError } from './http-errors.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { authenticateCliAgent, requireCommandForRole } from './team-authz.js'
import { TeamSkillRuntimeError } from './team-skill-runtime.js'

export const teamGrillRoutes: RouteDefinition[] = [
  route('POST', '/api/team/grill', async ({ request, response, store }) => {
    const body = await readJsonBody<
      ClarificationRequest & {
        project_id: string
        from_agent_id: string
        token?: string
      }
    >(request)
    if (!body || typeof body.project_id !== 'string' || !body.project_id.trim())
      throw new BadRequestError('Missing project_id')
    const agent = authenticateCliAgent({
      request,
      workspaceId: body.project_id,
      fromAgentId: body.from_agent_id,
      token: body.token,
      getAgent: store.getAgent,
      validateToken: store.validateAgentToken,
    })
    requireCommandForRole(agent, 'send')
    try {
      sendJson(
        response,
        202,
        await store.clarifications.request(
          body.project_id,
          agent.id,
          body,
          String(request.socket.localPort ?? '')
        )
      )
    } catch (error) {
      if (!(error instanceof TeamSkillRuntimeError)) throw error
      const notFound = new Set(['dispatch_not_found', 'skill_not_found'])
      const conflict = new Set(['ambiguous_skill', 'cache_drift', 'skill_runtime_unavailable'])
      sendJson(response, notFound.has(error.code) ? 404 : conflict.has(error.code) ? 409 : 403, {
        error: error.message,
        error_code: error.code,
      })
    }
  }),
]
