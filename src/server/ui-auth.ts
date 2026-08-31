import { randomUUID } from 'node:crypto'

export interface UiAuth {
  getSupervisorToken: () => string
  getToken: () => string
  validate: (token: string | undefined) => boolean
  getRemoteTunnelSecret: () => string
  validateRemoteTunnelSecret: (secret: string | undefined) => boolean
  validateSupervisorToken: (token: string | undefined) => boolean
}

export const createUiAuth = (): UiAuth => {
  const token = randomUUID()
  const remoteTunnelSecret = randomUUID()
  // This is deliberately process-local. The MCP client gets it from a
  // loopback-only endpoint on every call, so it never becomes a persisted
  // credential and cannot be recovered through the remote tunnel.
  const supervisorToken = randomUUID()

  return {
    getSupervisorToken() {
      return supervisorToken
    },
    getToken() {
      return token
    },
    validate(input) {
      return input === token
    },
    getRemoteTunnelSecret() {
      return remoteTunnelSecret
    },
    validateRemoteTunnelSecret(input) {
      return input === remoteTunnelSecret
    },
    validateSupervisorToken(input) {
      return input === supervisorToken
    },
  }
}
