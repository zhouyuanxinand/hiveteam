import type { Database } from 'better-sqlite3'

import { fromBase64Url, toBase64Url } from '../shared/remote-crypto.js'
import type { DeviceSession, DeviceSessionProvider } from './remote-device-session.js'

export interface RemoteDeviceRecord {
  id: string
  name: string
  createdAt: number
  lastActive: number | null
  revokedAt: number | null
}

export interface PersistDeviceInput {
  id: string
  name: string
  keys: {
    d2p: Uint8Array
    p2d: Uint8Array
  }
  devicePublicKey: Uint8Array
}

type DeviceRow = {
  id: string
  name: string
  created_at: number
  last_active: number | null
  revoked_at: number | null
  d2p_key?: Buffer
  p2d_key?: Buffer
  device_public_key?: Buffer
  key_d2p?: string
  key_p2d?: string
  device_pubkey?: string
}

const toRecord = (
  row: Pick<DeviceRow, 'id' | 'name' | 'created_at' | 'last_active' | 'revoked_at'>
) => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  lastActive: row.last_active,
  revokedAt: row.revoked_at,
})

const toBytes = (value: Buffer | string | undefined, name: string): Uint8Array => {
  if (typeof value === 'string') return fromBase64Url(value)
  if (value instanceof Uint8Array) return new Uint8Array(value)
  throw new Error(`remote device record is missing ${name}`)
}

const toSession = (row: DeviceRow, usesLegacyKeyColumns: boolean): DeviceSession => ({
  deviceId: row.id,
  keys: {
    d2p: toBytes(usesLegacyKeyColumns ? row.key_d2p : row.d2p_key, 'd2p key'),
    p2d: toBytes(usesLegacyKeyColumns ? row.key_p2d : row.p2d_key, 'p2d key'),
  },
  devicePublicKey: toBytes(
    usesLegacyKeyColumns ? row.device_pubkey : row.device_public_key,
    'device public key'
  ),
})

export interface RemoteDeviceStore {
  insert(input: PersistDeviceInput, now?: number): RemoteDeviceRecord
  getLiveSession(deviceId: string): DeviceSession | null
  liveSessions(): DeviceSession[]
  list(includeRevoked?: boolean): RemoteDeviceRecord[]
  get(deviceId: string): RemoteDeviceRecord | null
  revoke(deviceId: string, now?: number): boolean
  touchActive(deviceId: string, now?: number): void
}

export const createRemoteDeviceStore = (db: Database): RemoteDeviceStore => {
  const remoteDeviceColumns = new Set(
    (db.prepare('PRAGMA table_info(remote_devices)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  const usesLegacyKeyColumns =
    !remoteDeviceColumns.has('d2p_key') &&
    remoteDeviceColumns.has('key_d2p') &&
    remoteDeviceColumns.has('key_p2d') &&
    remoteDeviceColumns.has('device_pubkey')

  if (
    !usesLegacyKeyColumns &&
    (!remoteDeviceColumns.has('d2p_key') ||
      !remoteDeviceColumns.has('p2d_key') ||
      !remoteDeviceColumns.has('device_public_key'))
  ) {
    throw new Error('remote_devices table has an unsupported key column layout')
  }

  const insert = usesLegacyKeyColumns
    ? db.prepare(
        `INSERT INTO remote_devices (
           id, name, key_d2p, key_p2d, device_pubkey, created_at, last_active, revoked_at
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           key_d2p = excluded.key_d2p,
           key_p2d = excluded.key_p2d,
           device_pubkey = excluded.device_pubkey,
           last_active = NULL,
           revoked_at = NULL`
      )
    : db.prepare(
        `INSERT INTO remote_devices (
           id, name, created_at, last_active, revoked_at, d2p_key, p2d_key, device_public_key
         ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           last_active = NULL,
           revoked_at = NULL,
           d2p_key = excluded.d2p_key,
           p2d_key = excluded.p2d_key,
           device_public_key = excluded.device_public_key`
      )
  const find = db.prepare('SELECT * FROM remote_devices WHERE id = ?')

  return {
    insert(input, now = Date.now()) {
      if (usesLegacyKeyColumns) {
        insert.run(
          input.id,
          input.name,
          toBase64Url(input.keys.d2p),
          toBase64Url(input.keys.p2d),
          toBase64Url(input.devicePublicKey),
          now
        )
      } else {
        insert.run(
          input.id,
          input.name,
          now,
          Buffer.from(input.keys.d2p),
          Buffer.from(input.keys.p2d),
          Buffer.from(input.devicePublicKey)
        )
      }
      return toRecord(find.get(input.id) as DeviceRow)
    },
    getLiveSession(deviceId) {
      const row = find.get(deviceId) as DeviceRow | undefined
      return row && row.revoked_at === null ? toSession(row, usesLegacyKeyColumns) : null
    },
    liveSessions() {
      return (
        db
          .prepare('SELECT * FROM remote_devices WHERE revoked_at IS NULL ORDER BY created_at ASC')
          .all() as DeviceRow[]
      ).map((row) => toSession(row, usesLegacyKeyColumns))
    },
    list(includeRevoked = false) {
      const rows = (
        includeRevoked
          ? db.prepare('SELECT * FROM remote_devices ORDER BY created_at DESC')
          : db.prepare(
              'SELECT * FROM remote_devices WHERE revoked_at IS NULL ORDER BY created_at DESC'
            )
      ).all() as DeviceRow[]
      return rows.map(toRecord)
    },
    get(deviceId) {
      const row = find.get(deviceId) as DeviceRow | undefined
      return row ? toRecord(row) : null
    },
    revoke(deviceId, now = Date.now()) {
      const result = db
        .prepare(
          'UPDATE remote_devices SET revoked_at = COALESCE(revoked_at, ?), last_active = last_active WHERE id = ?'
        )
        .run(now, deviceId)
      return result.changes > 0
    },
    touchActive(deviceId, now = Date.now()) {
      db.prepare(
        'UPDATE remote_devices SET last_active = ? WHERE id = ? AND revoked_at IS NULL'
      ).run(now, deviceId)
    },
  }
}

export const createPersistentDeviceSessionProvider = (
  store: RemoteDeviceStore
): DeviceSessionProvider => ({
  get: (deviceId) => store.getLiveSession(deviceId),
  candidates: () => store.liveSessions(),
})
