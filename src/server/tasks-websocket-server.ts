import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'

import type { WebSocket as WsSocket } from 'ws'
import { WebSocketServer } from 'ws'

import { getLocalRequestRejection } from './local-request-guard.js'
import { RemotePermissionError } from './remote-permission-store.js'
import {
  authenticateUiRequest,
  getRequestPrincipal,
  setRequestPrincipal,
} from './request-principal.js'
import type { RuntimeStore } from './runtime-store.js'
import { type TasksFileService, tasksSnapshot } from './tasks-file.js'

const matchTasksPath = (pathname: string) => {
  const match = /^\/ws\/tasks\/(?<workspaceId>[^/]+)$/.exec(pathname)
  const workspaceId = match?.groups?.workspaceId
  return workspaceId ? decodeURIComponent(workspaceId) : null
}

const rejectUpgrade = (
  socket: Parameters<Server['on']>[1] extends (...args: infer T) => void ? T[1] : never,
  status: string
) => {
  socket.write(`HTTP/1.1 ${status}\r\n\r\n`)
  socket.destroy()
}

export interface TasksWebSocketServer {
  close: () => void
  publish: (workspaceId: string, content: string) => void
}

export const createTasksWebSocketServer = (
  server: Server,
  store: RuntimeStore,
  tasksFileService: Pick<TasksFileService, 'readTasks'>
): TasksWebSocketServer => {
  const wss = new WebSocketServer({ noServer: true })
  const socketsByWorkspaceId = new Map<string, Set<WsSocket>>()

  let closed = false
  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (closed) {
      rejectUpgrade(socket, '503 Service Unavailable')
      return
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const workspaceId = matchTasksPath(url.pathname)
    if (!workspaceId) return
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
    let workspacePath = ''
    try {
      if (principal.kind === 'remote_device')
        store.remote.permissions.assertRead(principal.deviceId, workspaceId)
      workspacePath = store.getWorkspaceSnapshot(workspaceId).summary.path
    } catch (error) {
      rejectUpgrade(
        socket,
        error instanceof RemotePermissionError ? '403 Forbidden' : '404 Not Found'
      )
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      setRequestPrincipal(ws, principal)
      const sockets = socketsByWorkspaceId.get(workspaceId) ?? new Set<WsSocket>()
      sockets.add(ws)
      socketsByWorkspaceId.set(workspaceId, sockets)
      ws.on('close', () => {
        sockets.delete(ws)
        if (sockets.size === 0) {
          socketsByWorkspaceId.delete(workspaceId)
        }
      })
      if (principal.kind === 'remote_device') {
        const check = () => {
          if (!store.remote.permissions.canRead(principal.deviceId, workspaceId))
            ws.close(1008, 'Workspace access revoked')
        }
        const timer = setInterval(check, 1000)
        timer.unref()
        const unsubscribe = store.remote.permissions.subscribe((deviceId) => {
          if (deviceId === principal.deviceId) check()
        })
        ws.once('close', () => {
          clearInterval(timer)
          unsubscribe()
        })
      }
      setImmediate(() => {
        if (ws.readyState !== ws.OPEN) return
        if (
          principal.kind === 'remote_device' &&
          !store.remote.permissions.canRead(principal.deviceId, workspaceId)
        ) {
          ws.close(1008, 'Workspace access revoked')
          return
        }
        try {
          ws.send(
            JSON.stringify({
              type: 'tasks-snapshot',
              ...tasksSnapshot(tasksFileService.readTasks(workspacePath)),
            })
          )
        } catch (error) {
          if (ws.readyState === ws.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'tasks-error',
                error: error instanceof Error ? error.message : 'Tasks could not be read',
              })
            )
          }
        }
      })
    })
  }
  server.on('upgrade', handleUpgrade)

  return {
    close: () => {
      if (closed) return
      closed = true
      server.off('upgrade', handleUpgrade)
      for (const sockets of socketsByWorkspaceId.values()) {
        for (const socket of sockets) socket.terminate()
      }
      socketsByWorkspaceId.clear()
      wss.close()
    },
    publish: (workspaceId, content) => {
      const sockets = socketsByWorkspaceId.get(workspaceId)
      if (!sockets) return
      const payload = JSON.stringify({ type: 'tasks-updated', ...tasksSnapshot(content) })
      for (const socket of sockets) {
        const principal = getRequestPrincipal(socket)
        if (
          principal?.kind === 'remote_device' &&
          !store.remote.permissions.canRead(principal.deviceId, workspaceId)
        ) {
          socket.close(1008, 'Workspace access revoked')
          continue
        }
        if (socket.readyState === socket.OPEN) {
          socket.send(payload)
        }
      }
    },
  }
}
