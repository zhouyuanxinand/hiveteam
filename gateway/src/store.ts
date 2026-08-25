import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const DAEMON_CODE_TTL_MS = 5 * 60 * 1000

export interface DaemonRecord {
  id: string
  name: string | null
  tokenHash: string
  token: string
  createdAt: number
  revokedAt: number | null
}

export interface DeviceRecord {
  id: string
  daemonId: string
  name: string
  devicePubkey: string
  createdAt: number
  revokedAt: number | null
}

interface DaemonCodeRecord {
  code: string
  expiresAt: number
  approvedAt: number | null
  daemonId: string | null
}

interface PersistedState {
  version: 1
  daemonCodes: DaemonCodeRecord[]
  daemons: DaemonRecord[]
  devices: DeviceRecord[]
}

export interface GatewayStore {
  issueDaemonCode(now?: number): { code: string; expiresAt: number }
  approveDaemonCode(code: string, ownerToken: string, now?: number): boolean
  exchangeDaemonToken(
    code: string,
    name?: string,
    now?: number
  ): { daemonId: string; daemonToken: string } | null
  authenticateDaemon(token: string): DaemonRecord | null
  getDaemon(id: string): DaemonRecord | null
  listDaemons(): DaemonRecord[]
  createSession(): string
  hasSession(sessionId: string): boolean
  ownerToken(): string
  upsertDevice(input: {
    daemonId: string
    id: string
    name: string
    devicePubkey: string
    now?: number
  }): DeviceRecord | null
  getDevice(id: string): DeviceRecord | null
  listDevices(daemonId?: string): DeviceRecord[]
  revokeDevice(id: string, now?: number): boolean
  close(): void
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')

const readState = (path: string): PersistedState => {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PersistedState>
    if (
      parsed.version !== 1 ||
      !Array.isArray(parsed.daemonCodes) ||
      !Array.isArray(parsed.daemons) ||
      !Array.isArray(parsed.devices)
    ) {
      throw new Error('unsupported gateway state format')
    }
    return {
      version: 1,
      daemonCodes: parsed.daemonCodes as DaemonCodeRecord[],
      daemons: parsed.daemons as DaemonRecord[],
      devices: parsed.devices as DeviceRecord[],
    }
  } catch (error) {
    const code = error as NodeJS.ErrnoException
    if (code.code === 'ENOENT') {
      return { version: 1, daemonCodes: [], daemons: [], devices: [] }
    }
    throw error
  }
}

export const createGatewayStore = (options: {
  dataDir: string
  ownerToken?: string
}): GatewayStore => {
  const statePath = join(options.dataDir, 'gateway.json')
  mkdirSync(dirname(statePath), { recursive: true })
  const state = readState(statePath)
  const ownerToken = options.ownerToken ?? randomToken(24)
  const ownerTokenDigest = hashToken(ownerToken)
  const sessions = new Set<string>()

  const persist = () => {
    const temporaryPath = `${statePath}.${process.pid}.tmp`
    writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(temporaryPath, statePath)
  }

  const sweepCodes = (now: number) => {
    state.daemonCodes = state.daemonCodes.filter(
      (entry) => entry.expiresAt > now && (entry.daemonId === null || !entry.approvedAt)
    )
  }

  return {
    issueDaemonCode(now = Date.now()) {
      sweepCodes(now)
      const record = {
        code: randomToken(18),
        expiresAt: now + DAEMON_CODE_TTL_MS,
        approvedAt: null,
        daemonId: null,
      }
      state.daemonCodes.push(record)
      persist()
      return { code: record.code, expiresAt: record.expiresAt }
    },

    approveDaemonCode(code, candidate, now = Date.now()) {
      sweepCodes(now)
      if (!safeEqual(hashToken(candidate), ownerTokenDigest)) return false
      const record = state.daemonCodes.find((entry) => entry.code === code)
      if (!record || record.expiresAt <= now) return false
      record.approvedAt = now
      persist()
      return true
    },

    exchangeDaemonToken(code, name, now = Date.now()) {
      sweepCodes(now)
      const record = state.daemonCodes.find((entry) => entry.code === code)
      if (!record || record.expiresAt <= now || record.approvedAt === null) return null
      if (record.daemonId) {
        const existing = state.daemons.find((daemon) => daemon.id === record.daemonId)
        return existing ? { daemonId: existing.id, daemonToken: existing.token } : null
      }
      const daemonToken = randomToken()
      const daemon: DaemonRecord = {
        id: randomUUID(),
        name: name?.trim().slice(0, 80) || null,
        tokenHash: hashToken(daemonToken),
        token: daemonToken,
        createdAt: now,
        revokedAt: null,
      }
      record.daemonId = daemon.id
      state.daemons.push(daemon)
      persist()
      return { daemonId: daemon.id, daemonToken }
    },

    authenticateDaemon(token) {
      const digest = hashToken(token)
      const daemon = state.daemons.find(
        (candidate) => candidate.revokedAt === null && safeEqual(candidate.tokenHash, digest)
      )
      return daemon ?? null
    },

    getDaemon(id) {
      return state.daemons.find((daemon) => daemon.id === id && daemon.revokedAt === null) ?? null
    },

    listDaemons() {
      return state.daemons.filter((daemon) => daemon.revokedAt === null)
    },

    createSession() {
      const sessionId = randomToken(24)
      sessions.add(sessionId)
      return sessionId
    },

    hasSession(sessionId) {
      return sessions.has(sessionId)
    },

    ownerToken() {
      return ownerToken
    },

    upsertDevice(input) {
      const daemon = state.daemons.find(
        (candidate) => candidate.id === input.daemonId && candidate.revokedAt === null
      )
      if (!daemon) return null
      const existing = state.devices.find((device) => device.id === input.id)
      const record: DeviceRecord = {
        id: input.id,
        daemonId: input.daemonId,
        name: input.name.trim().slice(0, 80) || 'Hive device',
        devicePubkey: input.devicePubkey,
        createdAt: existing?.createdAt ?? input.now ?? Date.now(),
        revokedAt: null,
      }
      if (existing) Object.assign(existing, record)
      else state.devices.push(record)
      persist()
      return record
    },

    getDevice(id) {
      return state.devices.find((device) => device.id === id && device.revokedAt === null) ?? null
    },

    listDevices(daemonId) {
      return state.devices.filter(
        (device) => device.revokedAt === null && (!daemonId || device.daemonId === daemonId)
      )
    },

    revokeDevice(id, now = Date.now()) {
      const device = state.devices.find(
        (candidate) => candidate.id === id && candidate.revokedAt === null
      )
      if (!device) return false
      device.revokedAt = now
      persist()
      return true
    },

    close() {
      sessions.clear()
    },
  }
}
