import { describe, expect, test } from 'vitest'

import {
  deriveConnectionKeys,
  deriveDaemonSession,
  deriveDeviceSession,
  deserializeDeviceKeyPair,
  generateDeviceKeyPair,
  openNext,
  sealNext,
  serializeDeviceKeyPair,
} from '../../src/shared/remote-crypto.js'
import { encodeHeader, FrameKind, PROTOCOL_VERSION } from '../../src/shared/remote-protocol.js'

const bytes = (seed: number) => Uint8Array.from({ length: 32 }, (_, index) => (seed + index) & 0xff)

describe('remote crypto', () => {
  test('derives identical directional roots on both sides', () => {
    const daemon = generateDeviceKeyPair()
    const device = generateDeviceKeyPair()
    const ids = { daemonId: 'daemon-1', deviceId: 'device-1', protocolVersion: PROTOCOL_VERSION }
    const args = {
      pairingSecret: bytes(10),
      sessionSalt: bytes(50),
      daemonPublicKey: daemon.publicKey,
      devicePublicKey: device.publicKey,
      ids,
    }
    const fromDaemon = deriveDaemonSession({
      daemonSecretKey: daemon.secretKey,
      ...args,
    })
    const fromDevice = deriveDeviceSession({
      deviceSecretKey: device.secretKey,
      ...args,
    })

    expect(fromDaemon.d2p).toEqual(fromDevice.d2p)
    expect(fromDaemon.p2d).toEqual(fromDevice.p2d)
    expect(fromDaemon.d2p).not.toEqual(fromDaemon.p2d)
    expect(fromDaemon.sas).toMatch(/^\d{6}$/)
    expect(fromDaemon.sas).toBe(fromDevice.sas)
  })

  test('rekeys every connection and round-trips an authenticated frame', () => {
    const rootD2p = bytes(1)
    const rootP2d = bytes(2)
    const ids = { daemonId: 'daemon-1', deviceId: 'device-1', protocolVersion: PROTOCOL_VERSION }
    const first = deriveConnectionKeys({
      rootD2p,
      rootP2d,
      phoneConnSalt: bytes(3),
      daemonConnSalt: bytes(4),
      ids,
    })
    const second = deriveConnectionKeys({
      rootD2p,
      rootP2d,
      phoneConnSalt: bytes(5),
      daemonConnSalt: bytes(6),
      ids,
    })
    expect(first.d2p).not.toEqual(second.d2p)

    const header = encodeHeader({
      version: PROTOCOL_VERSION,
      kind: FrameKind.Data,
      flags: 1,
      streamId: 2,
      seq: 0,
    })
    const sealer = { direction: 'd2p' as const, nextSeq: 0 }
    const opener = { direction: 'd2p' as const, lastSeq: -1 }
    const sealed = sealNext(sealer, {
      key: first.d2p,
      streamId: 2,
      headerBytes: header,
      payload: new TextEncoder().encode('hello from Hive'),
    })
    expect(
      new TextDecoder().decode(
        openNext(opener, { ...sealed, key: first.d2p, streamId: 2, headerBytes: header })
      )
    ).toBe('hello from Hive')
    expect(() =>
      openNext(opener, { ...sealed, key: first.d2p, streamId: 2, headerBytes: header })
    ).toThrow('out-of-order or replayed frame')

    const tamperedHeader = header.slice()
    tamperedHeader[2] = 1
    expect(() =>
      openNext(
        { direction: 'd2p', lastSeq: -1 },
        {
          ...sealed,
          key: first.d2p,
          streamId: 2,
          headerBytes: tamperedHeader,
        }
      )
    ).toThrow()
  })

  test('serializes device key material without changing bytes', () => {
    const keyPair = generateDeviceKeyPair()
    expect(deserializeDeviceKeyPair(serializeDeviceKeyPair(keyPair))).toEqual(keyPair)
  })
})
