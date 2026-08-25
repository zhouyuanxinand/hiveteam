import type { Database } from 'better-sqlite3'

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
  d2p_key: Buffer
  p2d_key: Buffer
  device_public_key: Buffer
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

const toSession = (row: DeviceRow): DeviceSession => ({
  deviceId: row.id,
  keys: {
    d2p: new Uint8Array(row.d2p_key),
    p2d: new Uint8Array(row.p2d_key),
  },
  devicePublicKey: new Uint8Array(row.device_public_key),
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
  const insert = db.prepare(
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
      insert.run(
        input.id,
        input.name,
        now,
        Buffer.from(input.keys.d2p),
        Buffer.from(input.keys.p2d),
        Buffer.from(input.devicePublicKey)
      )
      return toRecord(find.get(input.id) as DeviceRow)
    },
    getLiveSession(deviceId) {
      const row = find.get(deviceId) as DeviceRow | undefined
      return row && row.revoked_at === null ? toSession(row) : null
    },
    liveSessions() {
      return (
        db
          .prepare('SELECT * FROM remote_devices WHERE revoked_at IS NULL ORDER BY created_at ASC')
          .all() as DeviceRow[]
      ).map(toSession)
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
