import { BadRequestError } from './http-errors.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { TasksVersionConflict } from './tasks-file.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

export const taskRoutes: RouteDefinition[] = [
  route(
    'GET',
    '/api/workspaces/:workspaceId/tasks',
    ({ params, request, response, store, tasksFileService }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken)

      const workspace = store.getWorkspaceSnapshot(workspaceId)
      response.setHeader('Cache-Control', 'no-store')
      sendJson(response, 200, tasksFileService.readSnapshot(workspace.summary.path))
    }
  ),
  route(
    'PUT',
    '/api/workspaces/:workspaceId/tasks',
    async ({ params, request, response, store, tasksFileService }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken)

      const body = await readJsonBody<{ content: string; expected_version: string }>(request, {
        limitBytes: 540000,
      })
      if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new BadRequestError('Tasks update must be an object')
      const workspace = store.getWorkspaceSnapshot(workspaceId)
      try {
        sendJson(
          response,
          200,
          await tasksFileService.writeTasks(
            workspace.summary.path,
            body.content,
            body.expected_version,
            () => requireUiTokenFromRequest(request, store.validateUiToken)
          )
        )
      } catch (error) {
        if (!(error instanceof TasksVersionConflict)) throw error
        sendJson(response, 409, { error: error.message, code: error.code, current: error.current })
      }
    }
  ),
]
