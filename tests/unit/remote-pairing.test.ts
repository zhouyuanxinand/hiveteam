import { describe, expect, test } from 'vitest'
import { createRemotePairing } from '../../src/server/remote-pairing.js'
import { generateDeviceKeyPair } from '../../src/shared/remote-crypto.js'

describe('remote pairing', () => {
  test('requires desktop confirmation before persisting a device', () => {
    const auditEvents: unknown[] = []
    const inserted: unknown[] = []
    let nextId = 0
    const deviceStore = {
      insert(input: unknown) {
        inserted.push(input)
        return {
          id: 'device-1',
          name: 'Phone',
          createdAt: 1,
          lastActive: null,
          revokedAt: null,
        }
      },
    } as never
    const pairing = createRemotePairing({
      audit: { enqueue: (event: unknown) => auditEvents.push(event) } as never,
      deviceStore,
      getDaemonId: () => 'daemon-1',
      getGatewayUrl: () => 'https://gateway.example.test',
      now: () => 1000,
      ttlMs: 10_000,
      newId: () => `id-${++nextId}`,
      randomPairingCode: () => 'ABCD1234EFGH',
      randomPairingSecret: () => Uint8Array.from({ length: 32 }, (_, index) => index),
      setTimer: () => ({}) as never,
      clearTimer: () => {},
    })

    const ticket = pairing.beginPairing()
    expect(ticket.code).toBe('ABCD1234EFGH')
    expect(ticket.qr).toContain('gateway.example.test')
    expect(pairing.listPending()).toEqual([])

    const device = generateDeviceKeyPair()
    const pending = pairing.submitDeviceHello({
      pairingId: ticket.pairingId,
      devicePublicKey: device.publicKey,
      sessionSalt: Uint8Array.from({ length: 32 }, (_, index) => 100 + index),
      proposedName: 'Phone',
    })
    expect(pending?.sas).toMatch(/^\d{6}$/)
    expect(inserted).toHaveLength(0)
    expect(pairing.getHandshakeReply(ticket.pairingId)?.deviceId).toBe('id-2')

    const confirmed = pairing.confirmPairing(ticket.pairingId)
    expect(confirmed?.id).toBe('device-1')
    expect(inserted).toHaveLength(1)
    expect(pairing.getPending(ticket.pairingId)).toBeNull()
    expect(auditEvents).toHaveLength(1)
  })

  test('expires a ticket and rejects replayed handshakes', () => {
    let clock = 1000
    const pairing = createRemotePairing({
      audit: { enqueue: () => {} } as never,
      deviceStore: {
        insert: () => {
          throw new Error('not expected')
        },
      } as never,
      getDaemonId: () => 'daemon-1',
      getGatewayUrl: () => 'https://gateway.example.test',
      now: () => clock,
      ttlMs: 100,
      newId: () => 'pairing-1',
      randomPairingCode: () => 'ABCD1234EFGH',
      randomPairingSecret: () => new Uint8Array(32),
      setTimer: () => ({}) as never,
      clearTimer: () => {},
    })
    const ticket = pairing.beginPairing()
    clock = 1101
    expect(
      pairing.submitDeviceHello({
        pairingId: ticket.pairingId,
        devicePublicKey: generateDeviceKeyPair().publicKey,
        sessionSalt: new Uint8Array(32),
      })
    ).toBeNull()
  })
})
