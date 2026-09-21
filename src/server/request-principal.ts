import type { IncomingMessage } from 'node:http'

import { ForbiddenError } from './http-errors.js'
import { HIVE_REMOTE_DEVICE_HEADER, HIVE_REMOTE_SECRET_HEADER } from './remote-loopback-auth.js'
import type { RuntimeStore } from './runtime-store.js'

export type RequestPrincipal =
  | { kind: 'local_user' }
  | { kind: 'remote_device'; deviceId: string }
  | { kind: 'agent'; agentId: string; workspaceId: string }

const principals = new WeakMap<object, RequestPrincipal>()

export const getRequestPrincipal = (request: object) => principals.get(request)
export const setRequestPrincipal = (request: object, principal: RequestPrincipal) => {
  const current = principals.get(request)
  if (current && current.kind !== principal.kind) {
    throw new ForbiddenError('Credentials for different identities cannot be combined')
  }
  principals.set(request, principal)
}

export const readUiCookie = (header: string | undefined) => {
  for (const part of header?.split(';') ?? []) {
    const [key, value] = part.trim().split('=')
    if (key === 'hive_ui_token') return value
  }
  return undefined
}

/** Resolve transport identity once, without treating loopback access as authority. */
export const authenticateUiRequest = (request: IncomingMessage, store: RuntimeStore) => {
  const secret = request.headers[HIVE_REMOTE_SECRET_HEADER]
  const deviceId = request.headers[HIVE_REMOTE_DEVICE_HEADER]
  if (secret !== undefined || deviceId !== undefined) {
    if (
      typeof secret !== 'string' ||
      typeof deviceId !== 'string' ||
      !store.validateRemoteTunnelSecret(secret)
    ) {
      throw new ForbiddenError('Invalid remote device credentials')
    }
    const device = store.remote.devices.get(deviceId)
    if (!device || device.revokedAt !== null) {
      throw new ForbiddenError('Remote device is missing or revoked')
    }
    const principal = { kind: 'remote_device', deviceId } as const
    setRequestPrincipal(request, principal)
    return principal
  }
  if (store.validateUiToken(readUiCookie(request.headers.cookie))) {
    const principal = { kind: 'local_user' } as const
    setRequestPrincipal(request, principal)
    return principal
  }
  return undefined
}

export const requireLocalUser = (request: IncomingMessage, store: RuntimeStore) => {
  const principal = authenticateUiRequest(request, store)
  if (principal?.kind !== 'local_user') {
    throw new ForbiddenError('This action requires an authenticated desktop session')
  }
  return principal
}
