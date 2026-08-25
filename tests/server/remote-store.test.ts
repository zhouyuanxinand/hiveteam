import BetterSqlite3 from 'better-sqlite3'
import { describe, expect, test } from 'vitest'

import { createRemoteAuditStore } from '../../src/server/remote-audit-store.js'
import { createRemoteConfigSource } from '../../src/server/remote-config-keys.js'
import { createRemoteDeviceStore } from '../../src/server/remote-device-store.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

describe('remote persistence', () => {
  test('persists device metadata, key material and revocation state', () => {
    const db = new BetterSqlite3(':memory:')
    initializeRuntimeDatabase(db)
    const devices = createRemoteDeviceStore(db)
    const record = devices.insert({
      id: 'device-1',
      name: 'Phone',
      keys: { d2p: new Uint8Array([1, 2]), p2d: new Uint8Array([3, 4]) },
      devicePublicKey: new Uint8Array([5, 6]),
    })

    expect(record).toMatchObject({ id: 'device-1', name: 'Phone', revokedAt: null })
    expect(devices.getLiveSession('device-1')?.keys.d2p).toEqual(new Uint8Array([1, 2]))
    expect(devices.revoke('device-1')).toBe(true)
    expect(devices.getLiveSession('device-1')).toBeNull()
    expect(devices.list()).toEqual([])
    expect(devices.list(true)).toHaveLength(1)
    db.close()
  })

  test('supports the legacy remote device schema used by Hive 2.1.19', () => {
    const db = new BetterSqlite3(':memory:')
    db.exec(`
      CREATE TABLE remote_devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_d2p TEXT NOT NULL,
        key_p2d TEXT NOT NULL,
        device_pubkey TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_active INTEGER,
        revoked_at INTEGER
      )
    `)

    const devices = createRemoteDeviceStore(db)
    devices.insert({
      id: 'legacy-device',
      name: 'Legacy phone',
      keys: { d2p: new Uint8Array([1, 2]), p2d: new Uint8Array([3, 4]) },
      devicePublicKey: new Uint8Array([5, 6]),
    })

    expect(devices.getLiveSession('legacy-device')).toMatchObject({
      deviceId: 'legacy-device',
      keys: { d2p: new Uint8Array([1, 2]), p2d: new Uint8Array([3, 4]) },
      devicePublicKey: new Uint8Array([5, 6]),
    })
    expect(devices.list()).toHaveLength(1)
    db.close()
  })

  test('queues bounded audit previews and flushes them deterministically', async () => {
    const db = new BetterSqlite3(':memory:')
    initializeRuntimeDatabase(db)
    const audit = createRemoteAuditStore(db)
    audit.enqueue({
      action: 'ws_input',
      deviceId: 'device-1',
      endpoint: '/ws/terminal/run-1/io',
      result: 'ok',
      byteCount: 20,
      preview: 'x'.repeat(200),
    })
    await audit.flush()
    expect(audit.list()).toMatchObject([
      {
        action: 'ws_input',
        byte_count: 20,
        preview: 'x'.repeat(120),
      },
    ])
    db.close()
  })

  test('writes and reads the legacy remote audit device column', async () => {
    const db = new BetterSqlite3(':memory:')
    db.exec(`
      CREATE TABLE remote_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_device_id TEXT,
        ts INTEGER NOT NULL,
        workspace_id TEXT,
        action TEXT NOT NULL,
        endpoint TEXT,
        result TEXT NOT NULL,
        reject_reason TEXT,
        byte_count INTEGER,
        preview TEXT
      )
    `)

    const audit = createRemoteAuditStore(db)
    audit.enqueue({
      action: 'http',
      deviceId: 'legacy-device',
      endpoint: '/api/remote/status',
      result: 'ok',
    })
    await audit.flush()

    expect(audit.listForDevice('legacy-device')).toMatchObject([
      { device_id: 'legacy-device', endpoint: '/api/remote/status' },
    ])
    db.close()
  })

  test('keeps remote disabled unless explicitly stored as true', () => {
    const values = new Map<string, string | null>()
    const config = createRemoteConfigSource({
      get: (key) => {
        const value = values.get(key)
        return value === undefined ? undefined : { value }
      },
    })
    expect(config.isEnabled()).toBe(false)
    expect(config.getGatewayUrl()).toBeNull()
    values.set('remote_enabled', 'true')
    expect(config.isEnabled()).toBe(true)
  })
})
