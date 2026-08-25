import type { IncomingMessage } from 'node:http'

import { ForbiddenError } from './http-errors.js'
import type { RuntimeStore } from './runtime-store.js'

export const readCookie = (cookieHeader: string | undefined, name: string) => {
  if (!cookieHeader) {
    return undefined
  }

  for (const part of cookieHeader.split(';')) {
    const [key, value] = part.trim().split('=')
    if (key === name) {
      return value
    }
  }

  return undefined
}

export const requireUiTokenFromRequest = (
  request: IncomingMessage,
  validateUiToken: RuntimeStore['validateUiToken'],
  validateRemoteTunnelSecret?: RuntimeStore['validateRemoteTunnelSecret']
) => {
  const cookieHeader = Array.isArray(request.headers.cookie)
    ? request.headers.cookie.join('; ')
    : request.headers.cookie
  const token = readCookie(cookieHeader, 'hive_ui_token')
  const remoteSecretHeader = request.headers['x-hive-remote-secret']
  const remoteSecret = Array.isArray(remoteSecretHeader)
    ? remoteSecretHeader[0]
    : remoteSecretHeader
  if (
    !validateUiToken(token) &&
    !validateUiToken(remoteSecret) &&
    !validateRemoteTunnelSecret?.(remoteSecret)
  ) {
    throw new ForbiddenError('UI endpoint requires valid UI token')
  }
}
