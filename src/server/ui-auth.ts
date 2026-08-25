import { randomUUID } from 'node:crypto'

export interface UiAuth {
  getToken: () => string
  validate: (token: string | undefined) => boolean
  getRemoteTunnelSecret: () => string
  validateRemoteTunnelSecret: (secret: string | undefined) => boolean
}

export const createUiAuth = (): UiAuth => {
  const token = randomUUID()
  const remoteTunnelSecret = randomUUID()

  return {
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
  }
}
