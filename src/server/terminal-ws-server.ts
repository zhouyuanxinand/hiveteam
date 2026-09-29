import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'

import { WebSocketServer } from 'ws'
import { getLocalRequestRejection } from './local-request-guard.js'
import { workspaceForRun } from './remote-http-authorization.js'
import { RemotePermissionError } from './remote-permission-store.js'
import { authenticateUiRequest, setRequestPrincipal } from './request-principal.js'
import type { RuntimeStore } from './runtime-store.js'
import type { TasksFileService } from './tasks-file.js'
import { createTasksWebSocketServer } from './tasks-websocket-server.js'
import type { TerminalMirrorSize } from './terminal-state-mirror.js'
import { createTerminalStreamHub } from './terminal-stream-hub.js'

const matchTerminalPath = (pathname: string) => {
  const match = /^\/ws\/terminal\/(?<runId>[^/]+)\/(?<channel>io|control)$/.exec(pathname)
  const groups = match?.groups
  if (!groups?.runId || !groups.channel) return null
  return {
    channel: groups.channel as 'control' | 'io',
    runId: decodeURIComponent(groups.runId),
  }
}

const getClientId = (url: URL) => {
  return url.searchParams.get('clientId')?.trim() || 'legacy'
}

const getInitialSize = (url: URL): TerminalMirrorSize | undefined => {
  const cols = Number(url.searchParams.get('cols'))
  const rows = Number(url.searchParams.get('rows'))
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
    return undefined
  }
  return { cols, rows }
}

const rejectUpgrade = (
  socket: Parameters<Server['on']>[1] extends (...args: infer T) => void ? T[1] : never,
  status: string
) => {
  socket.write(`HTTP/1.1 ${status}\r\n\r\n`)
  socket.destroy()
}

export const createTerminalWebSocketServer = (
  server: Server,
  store: RuntimeStore,
  tasksFileService: Pick<TasksFileService, 'readTasks'>
) => {
  const ioWss = new WebSocketServer({ noServer: true })
  const controlWss = new WebSocketServer({ noServer: true })
  const tasksWss = createTasksWebSocketServer(server, store, tasksFileService)
  const hub = createTerminalStreamHub(store)
  const disposeTasksListener = store.registerTasksListener((workspaceId, content) => {
    tasksWss.publish(workspaceId, content)
  })

  let closed = false
  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (closed) {
      rejectUpgrade(socket, '503 Service Unavailable')
      return
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const pathname = url.pathname
    const match = matchTerminalPath(pathname)
    if (!match) {
      if (/^\/ws\/tasks\/.+/.test(pathname)) {
        return
      }
      rejectUpgrade(socket, '404 Not Found')
      return
    }
    if (getLocalRequestRejection(request)) {
      rejectUpgrade(socket, '403 Forbidden')
      return
    }
    let principal: ReturnType<typeof authenticateUiRequest>
    try {
      principal = authenticateUiRequest(request, store)
    } catch {
      rejectUpgrade(socket, '403 Forbidden')
      return
    }
    if (!principal) {
      rejectUpgrade(socket, '401 Unauthorized')
      return
    }

    try {
      store.getLiveRun(match.runId)
      if (principal.kind === 'remote_device')
        store.remote.permissions.assertRead(principal.deviceId, workspaceForRun(store, match.runId))
    } catch (error) {
      rejectUpgrade(
        socket,
        error instanceof RemotePermissionError ? '403 Forbidden' : '404 Not Found'
      )
      return
    }

    const wss = match.channel === 'io' ? ioWss : controlWss
    wss.handleUpgrade(request, socket, head, (ws) => {
      setRequestPrincipal(ws, principal)
      const clientId = JSON.stringify([
        principal.kind,
        principal.kind === 'remote_device' ? principal.deviceId : 'desktop',
        getClientId(url),
      ])
      // Remote viewers never resize the shared mirror by connecting. Explicit
      // resize messages need a separately approved capability.
      const initialSize = principal.kind === 'remote_device' ? undefined : getInitialSize(url)
      const coordinated = url.searchParams.get('snapshot') === '1'
      if (match.channel === 'io')
        hub.attachIo(
          match.runId,
          clientId,
          ws,
          initialSize,
          coordinated,
          String(request.socket.localPort ?? '')
        )
      else hub.attachControl(match.runId, clientId, ws, initialSize, coordinated)
    })
  }
  server.on('upgrade', handleUpgrade)

  const close = () => {
    if (closed) return
    closed = true
    server.off('upgrade', handleUpgrade)
    disposeTasksListener()
    hub.close()
    for (const socket of ioWss.clients) socket.terminate()
    for (const socket of controlWss.clients) socket.terminate()
    ioWss.close()
    controlWss.close()
    tasksWss.close()
  }
  server.once('close', close)

  return { close, metrics: () => hub.metrics() }
}
