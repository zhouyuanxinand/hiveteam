import { BadRequestError } from './http-errors.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { TasksVersionConflict } from './tasks-file.js'
import { authenticateCliAgent, requireCommandForRole } from './team-authz.js'

export const teamTasksRoutes: RouteDefinition[] = ['read', 'write'].map((action) =>
  route(
    'POST',
    `/api/team/tasks/${action}`,
    async ({ request, response, store, tasksFileService }) => {
      const body = await readJsonBody<{
        project_id: string
        from_agent_id: string
        token: string
        content: string
        expected_version: string
      }>(request, { limitBytes: 540000 })
      if (!body || typeof body.project_id !== 'string')
        throw new BadRequestError('project_id is required')
      const agent = authenticateCliAgent({
        request,
        fromAgentId: body.from_agent_id,
        token: body.token,
        workspaceId: body.project_id,
        getAgent: store.getAgent,
        validateToken: store.validateAgentToken,
      })
      requireCommandForRole(agent, action === 'write' ? 'tasks_write' : 'help')
      const path = store.getWorkspaceSnapshot(body.project_id).summary.path
      try {
        sendJson(
          response,
          200,
          action === 'read'
            ? tasksFileService.readSnapshot(path)
            : await tasksFileService.writeTasks(path, body.content, body.expected_version, () => {
                authenticateCliAgent({
                  request,
                  fromAgentId: body.from_agent_id,
                  token: body.token,
                  workspaceId: body.project_id,
                  getAgent: store.getAgent,
                  validateToken: store.validateAgentToken,
                })
              })
        )
      } catch (error) {
        if (!(error instanceof TasksVersionConflict)) throw error
        sendJson(response, 409, { error: error.message, code: error.code, current: error.current })
      }
    }
  )
)
