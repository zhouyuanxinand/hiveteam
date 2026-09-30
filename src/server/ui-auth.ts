import { randomUUID } from 'node:crypto'

import { ForbiddenError } from './http-errors.js'

export interface UiAuth {
  getSupervisorToken: () => string
  getToken: () => string
  createBootstrap: () => string
  exchangeBootstrap: (token: string) => string
  validate: (token: string | undefined) => boolean
  getRemoteTunnelSecret: () => string
  validateRemoteTunnelSecret: (secret: string | undefined) => boolean
  validateSupervisorToken: (token: string | undefined) => boolean
}

export const createUiAuth = (now: () => number = Date.now): UiAuth => {
  const token = randomUUID()
  const sessions = new Set<string>([token])
  const bootstraps = new Map<string, number>()
  const remoteTunnelSecret = randomUUID()
  // Process-local supervisor credentials are issued only through an
  // authenticated desktop action; the remote tunnel cannot retrieve them.
  const supervisorToken = randomUUID()

  return {
    getSupervisorToken() {
      return supervisorToken
    },
    getToken() {
      return token
    },
    createBootstrap() {
      for (const [value, expiresAt] of bootstraps) {
        if (expiresAt <= now()) bootstraps.delete(value)
      }
      const bootstrap = randomUUID()
      bootstraps.set(bootstrap, now() + 60_000)
      return bootstrap
    },
    exchangeBootstrap(bootstrap) {
      const expiresAt = bootstraps.get(bootstrap)
      bootstraps.delete(bootstrap)
      if (expiresAt === undefined || expiresAt <= now()) {
        throw new ForbiddenError(
          'UI bootstrap is invalid or expired; reopen HiveTeam from its launcher'
        )
      }
      const session = randomUUID()
      sessions.add(session)
      return session
    },
    validate(input) {
      return input !== undefined && sessions.has(input)
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
