import type WebSocket from 'ws'
import type { RemoteAction, RemoteTerminalPermissions } from '../shared/remote-permissions.js'
import { workspaceForRun } from './remote-http-authorization.js'
import { RemotePermissionError } from './remote-permission-store.js'
import { getRequestPrincipal } from './request-principal.js'
import type { RuntimeStore } from './runtime-store.js'

export const checkTerminalRead = (store: RuntimeStore, runId: string, socket: WebSocket) => {
  const principal = getRequestPrincipal(socket)
  if (principal?.kind !== 'remote_device') return true
  if (store.remote.permissions.canRead(principal.deviceId, workspaceForRun(store, runId)))
    return true
  socket.close(1008, 'Workspace access revoked')
  return false
}

export const terminalGrant = (
  store: RuntimeStore,
  runId: string,
  socket: WebSocket,
  action: RemoteAction,
  byteCount?: number
) => {
  const principal = getRequestPrincipal(socket)
  if (principal?.kind !== 'remote_device') return null
  const workspaceId = workspaceForRun(store, runId)
  try {
    return store.remote.permissions.authorize(principal.deviceId, workspaceId, action)
  } catch (error) {
    if (!(error instanceof RemotePermissionError)) throw error
    store.remote.audit.append({
      deviceId: principal.deviceId,
      workspaceId,
      resourceId: runId,
      action: action === 'terminal_input' ? 'ws_input' : 'ws_control',
      businessAction: action,
      byteCount: byteCount ?? null,
      result: 'rejected',
      decision: 'deny',
      rejectReason: error.code,
    })
    throw error
  }
}

export const executeTerminalAction = (
  store: RuntimeStore,
  runId: string,
  socket: WebSocket,
  action: RemoteAction,
  execute: () => void,
  byteCount?: number
) => {
  const principal = getRequestPrincipal(socket)
  if (principal?.kind !== 'remote_device') {
    execute()
    return
  }
  const workspaceId = workspaceForRun(store, runId)
  const event = {
    deviceId: principal.deviceId,
    workspaceId,
    resourceId: runId,
    action: action === 'terminal_input' ? ('ws_input' as const) : ('ws_control' as const),
    businessAction: action,
    byteCount: byteCount ?? null,
  }
  const grantId = terminalGrant(store, runId, socket, action, byteCount)
  store.remote.audit.append({ ...event, grantId, result: 'authorized', decision: 'allow' })
  try {
    execute()
  } catch (error) {
    store.remote.audit.append({ ...event, grantId, result: 'error', decision: 'executed' })
    throw error
  }
  try {
    store.remote.audit.append({ ...event, grantId, result: 'ok', decision: 'executed' })
  } catch (error) {
    store.remote.permissions.blockAfterAuditFailure(error)
  }
}

export const observeTerminalPermissions = (
  store: RuntimeStore,
  runId: string,
  socket: WebSocket,
  emit: boolean
) => {
  const principal = getRequestPrincipal(socket)
  if (principal?.kind !== 'remote_device') return
  const workspaceId = workspaceForRun(store, runId)
  const update = () => {
    if (socket.readyState !== socket.OPEN) return
    try {
      if (!checkTerminalRead(store, runId, socket)) return
      const grants = store.remote.permissions
        .getAccess(principal.deviceId)
        .grants.filter((grant) => grant.workspace_id === workspaceId)
      if (emit)
        socket.send(
          JSON.stringify({
            type: 'permissions',
            workspace_id: workspaceId,
            actions: [...new Set(grants.flatMap((grant) => grant.actions))],
            remaining_ms: Math.max(0, ...grants.map((grant) => grant.remaining_ms)),
          } satisfies RemoteTerminalPermissions)
        )
    } catch (error) {
      store.remote.permissions.blockAfterAuditFailure(error)
      socket.close(1011, 'Remote access validation unavailable')
    }
  }
  update()
  const timer = setInterval(update, 1000)
  timer.unref()
  const unsubscribe = store.remote.permissions.subscribe((deviceId) => {
    if (deviceId === principal.deviceId) update()
  })
  socket.once('close', () => {
    clearInterval(timer)
    unsubscribe()
  })
}
