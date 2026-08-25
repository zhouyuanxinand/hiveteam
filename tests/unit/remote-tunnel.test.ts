import { EventEmitter } from 'node:events'
import BetterSqlite3 from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { createRemoteAuditStore } from '../../src/server/remote-audit-store.js'
import { createRemoteTunnel, relayDaemonUrl } from '../../src/server/remote-tunnel.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

class FakeSocket extends EventEmitter {
  static instances: FakeSocket[] = []
  readonly url: string
  readonly protocols: string[]
  readyState = 0
  binaryType = 'arraybuffer'
  readonly sent: unknown[] = []

  constructor(url: string, protocols: string[]) {
    super()
    this.url = url
    this.protocols = protocols
    FakeSocket.instances.push(this)
  }

  send(value: unknown) {
    this.sent.push(value)
  }

  close() {
    this.readyState = 3
  }

  terminate() {
    this.readyState = 3
  }
}

const makeConfig = () => {
  let enabled = false
  return {
    setEnabled(value: boolean) {
      enabled = value
    },
    isEnabled: () => enabled,
    getGatewayUrl: () => 'https://gateway.test/',
    getDaemonToken: () => (enabled ? 'daemon-token' : null),
    getDaemonId: () => 'daemon-1',
  }
}

describe('remote tunnel lifecycle', () => {
  test('does not construct a socket while remote access is disabled', () => {
    FakeSocket.instances = []
    const config = makeConfig()
    const tunnel = createRemoteTunnel({
      loopbackPort: 4010,
      config,
      deviceSessions: { get: () => null, candidates: () => [] },
      loopbackSecret: 'boot-secret',
      audit: { enqueue: () => {}, flush: async () => {}, list: () => [], listForDevice: () => [] },
      onStatus: () => {},
      WebSocketImpl: FakeSocket as unknown as typeof import('ws').WebSocket,
    })

    tunnel.refresh()
    expect(tunnel.status()).toBe('disabled')
    expect(FakeSocket.instances).toHaveLength(0)
  })

  test('connects with the gateway bearer subprotocol and latches revocation', async () => {
    FakeSocket.instances = []
    const config = makeConfig()
    const db = new BetterSqlite3(':memory:')
    initializeRuntimeDatabase(db)
    const audit = createRemoteAuditStore(db)
    const statuses: string[] = []
    const tunnel = createRemoteTunnel({
      loopbackPort: 4010,
      config,
      deviceSessions: { get: () => null, candidates: () => [] },
      loopbackSecret: 'boot-secret',
      audit,
      onStatus: (event) => statuses.push(event.status),
      WebSocketImpl: FakeSocket as unknown as typeof import('ws').WebSocket,
    })

    config.setEnabled(true)
    tunnel.refresh()
    const socket = FakeSocket.instances[0]
    expect(socket?.url).toBe('wss://gateway.test/relay/daemon')
    expect(socket?.protocols).toEqual(['bearer.daemon-token'])
    socket?.emit('open')
    expect(tunnel.status()).toBe('online')
    expect(socket?.sent.length).toBeGreaterThanOrEqual(1)

    socket?.emit(
      'message',
      Buffer.from(`${'\0gw:'}${JSON.stringify({ t: 'revoked', reason: 'device revoked' })}`),
      false
    )
    expect(tunnel.status()).toBe('revoked')
    expect(statuses).toContain('online')
    expect(statuses).toContain('revoked')
    await audit.flush()
    db.close()
  })

  test('rejects insecure non-loopback gateways', () => {
    expect(() => relayDaemonUrl('ws://gateway.test')).toThrow(/loopback/)
    expect(relayDaemonUrl('ws://127.0.0.1:8787/')).toBe('ws://127.0.0.1:8787/relay/daemon')
  })
})
