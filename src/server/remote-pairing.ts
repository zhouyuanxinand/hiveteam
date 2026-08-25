import { randomUUID } from 'node:crypto'
import { randomBytes } from '@noble/ciphers/utils.js'

import {
  type DeviceKeyPair,
  deriveDaemonSession,
  encodePairingPayload,
  generateDeviceKeyPair,
  type HandshakeIds,
  PAIRING_SECRET_LEN,
  REMOTE_CRYPTO_VERSION,
  SESSION_SALT_LEN,
  toBase64Url,
} from '../shared/remote-crypto.js'
import { generatePairingCode } from '../shared/remote-pairing-code.js'
import type { RemoteAuditStore } from './remote-audit-store.js'
import type { RemoteDeviceRecord, RemoteDeviceStore } from './remote-device-store.js'

export type PairingState =
  | 'awaiting_handshake'
  | 'awaiting_confirm'
  | 'confirmed'
  | 'rejected'
  | 'expired'

export const PAIRING_TTL_MS = 5 * 60 * 1000

export type PairingRejectReason =
  | 'pairing_expired'
  | 'pairing_replay'
  | 'pairing_unknown'
  | 'pairing_bad_input'
  | 'pairing_confirm_forbidden'

export interface PairingTicket {
  pairingId: string
  qr: string
  code: string
  expiresAt: number
}

export interface PendingPairingView {
  pairingId: string
  deviceName: string | null
  sas: string
  expiresAt: number
}

export interface HandshakeReply {
  daemonPublicKey: Uint8Array
  daemonId: string
  deviceId: string
  protocolVersion: number
}

export interface DevicePairingHello {
  pairingId: string
  devicePublicKey: Uint8Array
  sessionSalt: Uint8Array
  proposedName?: string
}

export interface RemotePairingDeps {
  deviceStore: RemoteDeviceStore
  audit: RemoteAuditStore
  getGatewayUrl: () => string | null
  getDaemonId: () => string | null
  now?: () => number
  ttlMs?: number
  newDaemonKeyPair?: () => DeviceKeyPair
  randomPairingSecret?: () => Uint8Array
  randomPairingCode?: () => string
  newId?: () => string
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout
  clearTimer?: (handle: NodeJS.Timeout) => void
}

type PairingEntry = {
  ticket: PairingTicket
  state: PairingState
  daemonKeyPair: DeviceKeyPair
  pairingSecret: Uint8Array
  deviceId: string | null
  devicePublicKey: Uint8Array | null
  deviceName: string | null
  sessionSalt: Uint8Array | null
  sessionKeys: { d2p: Uint8Array; p2d: Uint8Array } | null
  sas: string | null
  timer: NodeJS.Timeout | null
}

const normalizeName = (name: string | undefined) => {
  const trimmed = name?.trim()
  return trimmed ? trimmed.slice(0, 80) : null
}

export interface RemotePairing {
  beginPairing(): PairingTicket
  submitDeviceHello(hello: DevicePairingHello): PendingPairingView | null
  getHandshakeReply(pairingId: string): HandshakeReply | null
  confirmPairing(pairingId: string, opts?: { name?: string }): RemoteDeviceRecord | null
  rejectPairing(pairingId: string, reason?: string): void
  getPending(pairingId: string): PendingPairingView | null
  listPending(): PendingPairingView[]
  findAwaitingHandshake(): string | null
  dispose(): void
}

export const createRemotePairing = (deps: RemotePairingDeps): RemotePairing => {
  const now = deps.now ?? (() => Date.now())
  const ttlMs = deps.ttlMs ?? PAIRING_TTL_MS
  const newDaemonKeyPair = deps.newDaemonKeyPair ?? generateDeviceKeyPair
  const randomPairingSecret = deps.randomPairingSecret ?? (() => randomBytes(PAIRING_SECRET_LEN))
  const randomPairingCode = deps.randomPairingCode ?? (() => generatePairingCode(randomBytes))
  const newId = deps.newId ?? randomUUID
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle))
  const entries = new Map<string, PairingEntry>()

  const expire = (entry: PairingEntry) => {
    if (entry.state === 'awaiting_handshake' || entry.state === 'awaiting_confirm') {
      entry.state = 'expired'
      deps.audit.enqueue({
        action: 'reject',
        result: 'rejected',
        rejectReason: 'pairing_expired',
      })
    }
  }

  const getEntry = (pairingId: string) => {
    const entry = entries.get(pairingId)
    if (!entry) return null
    if (entry.ticket.expiresAt <= now()) expire(entry)
    return entry
  }

  return {
    beginPairing() {
      const gatewayUrl = deps.getGatewayUrl()
      const daemonId = deps.getDaemonId()
      if (!gatewayUrl || !daemonId) throw new Error('Remote access is not initialized')
      const pairingId = newId()
      const pairingSecret = randomPairingSecret()
      if (pairingSecret.length !== PAIRING_SECRET_LEN) {
        throw new RangeError(`pairing secret must be ${PAIRING_SECRET_LEN} bytes`)
      }
      const expiresAt = now() + ttlMs
      const ticket: PairingTicket = {
        pairingId,
        code: randomPairingCode(),
        expiresAt,
        qr: encodePairingPayload({
          v: REMOTE_CRYPTO_VERSION,
          gatewayUrl,
          daemonId,
          pairingSecret: toBase64Url(pairingSecret),
        }),
      }
      const entry: PairingEntry = {
        ticket,
        state: 'awaiting_handshake',
        daemonKeyPair: newDaemonKeyPair(),
        pairingSecret,
        deviceId: null,
        devicePublicKey: null,
        deviceName: null,
        sessionSalt: null,
        sessionKeys: null,
        sas: null,
        timer: null,
      }
      entry.timer = setTimer(() => expire(entry), ttlMs)
      entries.set(pairingId, entry)
      return ticket
    },
    submitDeviceHello(hello) {
      const entry = getEntry(hello.pairingId)
      if (!entry || entry.state !== 'awaiting_handshake') {
        deps.audit.enqueue({ action: 'reject', result: 'rejected', rejectReason: 'pairing_replay' })
        return null
      }
      if (hello.devicePublicKey.length !== 32 || hello.sessionSalt.length !== SESSION_SALT_LEN) {
        entry.state = 'rejected'
        deps.audit.enqueue({
          action: 'reject',
          result: 'rejected',
          rejectReason: 'pairing_bad_input',
        })
        return null
      }
      const daemonId = deps.getDaemonId()
      if (!daemonId) return null
      const deviceId = newId()
      const ids: HandshakeIds = {
        daemonId,
        deviceId,
        protocolVersion: REMOTE_CRYPTO_VERSION,
      }
      const session = deriveDaemonSession({
        daemonSecretKey: entry.daemonKeyPair.secretKey,
        daemonPublicKey: entry.daemonKeyPair.publicKey,
        devicePublicKey: hello.devicePublicKey,
        pairingSecret: entry.pairingSecret,
        sessionSalt: hello.sessionSalt,
        ids,
      })
      entry.deviceId = deviceId
      entry.devicePublicKey = hello.devicePublicKey.slice()
      entry.deviceName = normalizeName(hello.proposedName)
      entry.sessionSalt = hello.sessionSalt.slice()
      entry.sessionKeys = { d2p: session.d2p, p2d: session.p2d }
      entry.sas = session.sas
      entry.state = 'awaiting_confirm'
      return {
        pairingId: hello.pairingId,
        deviceName: entry.deviceName,
        sas: session.sas,
        expiresAt: entry.ticket.expiresAt,
      }
    },
    getHandshakeReply(pairingId) {
      const entry = getEntry(pairingId)
      if (!entry?.deviceId || entry.state !== 'awaiting_confirm') return null
      const daemonId = deps.getDaemonId()
      if (!daemonId) return null
      return {
        daemonPublicKey: entry.daemonKeyPair.publicKey.slice(),
        daemonId,
        deviceId: entry.deviceId,
        protocolVersion: REMOTE_CRYPTO_VERSION,
      }
    },
    confirmPairing(pairingId, opts = {}) {
      const entry = getEntry(pairingId)
      if (
        !entry ||
        entry.state !== 'awaiting_confirm' ||
        !entry.deviceId ||
        !entry.devicePublicKey ||
        !entry.sessionKeys
      ) {
        deps.audit.enqueue({
          action: 'reject',
          result: 'rejected',
          rejectReason: 'pairing_confirm_forbidden',
        })
        return null
      }
      const record = deps.deviceStore.insert({
        id: entry.deviceId,
        name: normalizeName(opts.name) ?? entry.deviceName ?? 'Hive device',
        keys: entry.sessionKeys,
        devicePublicKey: entry.devicePublicKey,
      })
      entry.state = 'confirmed'
      if (entry.timer) clearTimer(entry.timer)
      deps.audit.enqueue({ action: 'session_open', deviceId: record.id, result: 'ok' })
      return record
    },
    rejectPairing(pairingId, reason = 'pairing_rejected') {
      const entry = getEntry(pairingId)
      if (!entry || entry.state === 'confirmed') return
      entry.state = 'rejected'
      if (entry.timer) clearTimer(entry.timer)
      deps.audit.enqueue({
        action: 'reject',
        result: 'rejected',
        rejectReason: reason,
      })
    },
    getPending(pairingId) {
      const entry = getEntry(pairingId)
      if (!entry || entry.state !== 'awaiting_confirm' || !entry.sas) return null
      return {
        pairingId,
        deviceName: entry.deviceName,
        sas: entry.sas,
        expiresAt: entry.ticket.expiresAt,
      }
    },
    listPending() {
      const pending: PendingPairingView[] = []
      for (const entry of entries.values()) {
        const view = this.getPending(entry.ticket.pairingId)
        if (view) pending.push(view)
      }
      return pending
    },
    findAwaitingHandshake() {
      for (const entry of entries.values()) {
        if (getEntry(entry.ticket.pairingId)?.state === 'awaiting_handshake') {
          return entry.ticket.pairingId
        }
      }
      return null
    },
    dispose() {
      for (const entry of entries.values()) {
        if (entry.timer) clearTimer(entry.timer)
      }
      entries.clear()
    },
  }
}
