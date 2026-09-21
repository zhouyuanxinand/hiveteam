import { inspectDataBackup } from './data-backup.js'
import { restoreDataBackup } from './data-restore.js'
import { BadRequestError } from './http-errors.js'
import { requireLocalUser } from './request-principal.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
export const dataRecoveryRoutes: RouteDefinition[] = [
  route('POST', '/api/settings/backups', async ({ request, response, store }) => {
    requireLocalUser(request, store)
    const body = await readJsonBody<{ output: string; native_generations?: string[] }>(request)
    if (
      !body ||
      typeof body.output !== 'string' ||
      (body.native_generations !== undefined &&
        (!Array.isArray(body.native_generations) ||
          body.native_generations.some((id) => typeof id !== 'string')))
    )
      throw new BadRequestError('output directory and optional native_generations are required')
    sendJson(response, 201, await store.createBackup(body.output, body.native_generations))
  }),
  route('POST', '/api/settings/backups/inspect', async ({ request, response, store }) => {
    requireLocalUser(request, store)
    const body = await readJsonBody<{ directory: string }>(request)
    if (!body || typeof body.directory !== 'string')
      throw new BadRequestError('directory is required')
    sendJson(response, 200, await inspectDataBackup(body.directory))
  }),
  route('POST', '/api/settings/backups/restore', async ({ request, response, store }) => {
    requireLocalUser(request, store)
    const body = await readJsonBody<{
      directory: string
      target: string
      manifest_version: string
      workspace_bindings: Record<string, string>
      confirm: boolean
    }>(request)
    if (
      !body ||
      typeof body.directory !== 'string' ||
      typeof body.target !== 'string' ||
      typeof body.manifest_version !== 'string' ||
      !body.workspace_bindings ||
      typeof body.workspace_bindings !== 'object' ||
      Array.isArray(body.workspace_bindings)
    )
      throw new BadRequestError('Restore preview, target and bindings are required')
    sendJson(
      response,
      201,
      await restoreDataBackup({
        directory: body.directory,
        target: body.target,
        manifestVersion: body.manifest_version,
        workspaceBindings: body.workspace_bindings,
        confirm: body.confirm,
      })
    )
  }),
  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/retention',
    ({ request, response, store, params }) => {
      requireLocalUser(request, store)
      const id = params.workspaceId ?? ''
      store.getWorkspaceSnapshot(id)
      sendJson(response, 200, store.dataRetention.preview(id))
    }
  ),
  route(
    'POST',
    '/api/ui/workspaces/:workspaceId/retention',
    async ({ request, response, store, params }) => {
      requireLocalUser(request, store)
      const id = params.workspaceId ?? ''
      store.getWorkspaceSnapshot(id)
      const body = await readJsonBody<Parameters<typeof store.dataRetention.apply>[1]>(request)
      sendJson(response, 200, store.dataRetention.apply(id, body))
    }
  ),
]
