import type { ExecutionPolicyUpdate } from '../shared/execution-policy.js'
import { BadRequestError } from './http-errors.js'
import { requireLocalUser } from './request-principal.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { authenticateCliAgent, requireCommandForRole } from './team-authz.js'

const policyPath = '/api/ui/workspaces/:workspaceId/agents/:agentId/execution-policy'
export const executionPolicyRoutes: RouteDefinition[] = [
  route('GET', policyPath, async ({ request, response, params, store }) => {
    requireLocalUser(request, store)
    sendJson(
      response,
      200,
      await store.executionPolicies.preview(params.workspaceId ?? '', params.agentId ?? '')
    )
  }),
  route('PUT', policyPath, async ({ request, response, params, store }) => {
    requireLocalUser(request, store)
    const body = await readJsonBody<ExecutionPolicyUpdate>(request)
    sendJson(
      response,
      200,
      await store.executionPolicies.update(params.workspaceId ?? '', params.agentId ?? '', body)
    )
  }),
  route('DELETE', policyPath, async ({ request, response, params, store }) => {
    requireLocalUser(request, store)
    sendJson(
      response,
      200,
      await store.executionPolicies.revoke(params.workspaceId ?? '', params.agentId ?? '')
    )
  }),
  route('POST', '/api/team/git/commit', async ({ request, response, store }) => {
    const body = await readJsonBody<{
      project_id: string
      from_agent_id: string
      token?: string
      expected_head: string
      message: string
    }>(request)
    if (
      !body ||
      typeof body.project_id !== 'string' ||
      typeof body.from_agent_id !== 'string' ||
      typeof body.expected_head !== 'string' ||
      typeof body.message !== 'string'
    )
      throw new BadRequestError('project_id, from_agent_id, expected_head and message are required')
    const agent = authenticateCliAgent({
      request,
      fromAgentId: body.from_agent_id,
      workspaceId: body.project_id,
      token: body.token,
      getAgent: store.getAgent,
      validateToken: store.validateAgentToken,
    })
    requireCommandForRole(agent, 'git_commit')
    sendJson(
      response,
      200,
      await store.executionPolicies.commit(
        body.project_id,
        agent.id,
        body.expected_head,
        body.message
      )
    )
  }),
]
