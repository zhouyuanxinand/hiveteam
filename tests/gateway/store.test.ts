import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createGatewayStore } from '../../gateway/src/store.js'

const temporaryDirectories: string[] = []

const createTemporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), 'hive-gateway-store-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('gateway store', () => {
  test('requires owner approval and persists daemon credentials', () => {
    const dataDir = createTemporaryDirectory()
    const ownerToken = 'owner-token-for-tests'
    const store = createGatewayStore({ dataDir, ownerToken })
    const issued = store.issueDaemonCode(1_000)

    expect(store.exchangeDaemonToken(issued.code, 'test machine', 1_001)).toBeNull()
    expect(store.approveDaemonCode(issued.code, 'wrong-token', 1_002)).toBe(false)
    expect(store.approveDaemonCode(issued.code, ownerToken, 1_003)).toBe(true)

    const exchanged = store.exchangeDaemonToken(issued.code, 'test machine', 1_004)
    expect(exchanged).not.toBeNull()
    expect(store.authenticateDaemon(exchanged?.daemonToken ?? '')?.name).toBe('test machine')
    store.close()

    const reopened = createGatewayStore({ dataDir, ownerToken })
    expect(reopened.authenticateDaemon(exchanged?.daemonToken ?? '')?.id).toBe(exchanged?.daemonId)
    reopened.close()
  })

  test('upserts, lists, and revokes paired devices', () => {
    const dataDir = createTemporaryDirectory()
    const store = createGatewayStore({ dataDir, ownerToken: 'owner-token-for-tests' })
    const issued = store.issueDaemonCode(2_000)
    expect(store.approveDaemonCode(issued.code, store.ownerToken(), 2_001)).toBe(true)
    const daemon = store.exchangeDaemonToken(issued.code, 'test machine', 2_002)
    expect(daemon).not.toBeNull()

    const device = store.upsertDevice({
      daemonId: daemon?.daemonId ?? '',
      id: 'phone-1',
      name: 'Phone',
      devicePubkey: 'public-key',
      now: 2_003,
    })
    expect(device?.name).toBe('Phone')
    expect(store.listDevices(daemon?.daemonId)).toHaveLength(1)
    expect(store.revokeDevice('phone-1', 2_004)).toBe(true)
    expect(store.getDevice('phone-1')).toBeNull()
    expect(store.listDevices()).toEqual([])
    expect(store.revokeDevice('phone-1', 2_005)).toBe(false)
    store.close()
  })
})
