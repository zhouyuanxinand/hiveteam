import { isDesktopBridgeRequest, probeDroppedFolder } from './desktop-folder-probe.js'
import { browseDirectory, probeDirectory } from './fs-browse.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { DesktopFolderProbeBody, RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const readPathParam = (request: { url?: string | undefined }): string => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  return url.searchParams.get('path') ?? ''
}

export const fsRoutes: RouteDefinition[] = [
  route('POST', '/api/desktop/folders/probe', async ({ request, response }) => {
    if (!isDesktopBridgeRequest(request)) {
      sendJson(response, 404, { error: 'Not found' })
      return
    }

    const body = await readJsonBody<DesktopFolderProbeBody>(request, { limitBytes: 16 * 1024 })
    if (typeof body.path !== 'string') {
      sendJson(response, 400, { error: 'Absolute folder path required' })
      return
    }

    const probe = await probeDroppedFolder(body.path)
    if (!probe) {
      sendJson(response, 400, { error: 'Absolute folder path required' })
      return
    }

    sendJson(response, 200, probe)
  }),
  route('GET', '/api/fs/browse', async ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const body = await browseDirectory(readPathParam(request))
    sendJson(response, body.ok ? 200 : 400, body)
  }),
  route('GET', '/api/fs/probe', async ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const body = await probeDirectory(readPathParam(request))
    sendJson(response, 200, body)
  }),
  route('POST', '/api/fs/pick-folder', async ({ pickFolderService, request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const body = await pickFolderService()
    sendJson(response, 200, body)
  }),
]
