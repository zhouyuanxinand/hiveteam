import BetterSqlite3 from 'better-sqlite3'
import { describe, expect, test } from 'vitest'

import { createRemoteAuditStore } from '../../src/server/remote-audit-store.js'
import { InMemoryDeviceSessionProvider } from '../../src/server/remote-device-session.js'
import {
  createFrameBridge,
  type LoopbackHttpHandlers,
} from '../../src/server/remote-frame-bridge.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import {
  createOpener,
  createSealer,
  deriveConnectionKeys,
  openNext,
  sealNext,
} from '../../src/shared/remote-crypto.js'
import {
  CONN_SALT_STREAM_ID,
  decodeConnSalt,
  decodeHeader,
  decodeHttpData,
  encodeAckPayload,
  encodeConnSalt,
  encodeHeader,
  encodeOpenPayload,
  FrameKind,
  HEADER_BYTES,
  StreamTransport,
} from '../../src/shared/remote-protocol.js'

const fixedSalt = (value: number) => Uint8Array.from({ length: 32 }, () => value)
const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const createHttpBridgeHarness = () => {
  const db = new BetterSqlite3(':memory:')
  initializeRuntimeDatabase(db)
  const audit = createRemoteAuditStore(db)
  const sessions = new InMemoryDeviceSessionProvider()
  sessions.set({
    deviceId: 'device-1',
    keys: { d2p: fixedSalt(1), p2d: fixedSalt(2) },
    devicePublicKey: fixedSalt(3),
  })

  const outgoing: Uint8Array[] = []
  let requestArgs: { method: string; path: string; headers: Record<string, string> } | null = null
  let requestHandlers: LoopbackHttpHandlers | null = null
  const bridge = createFrameBridge({
    loopbackPort: 4010,
    loopbackSecret: 'boot-secret',
    deviceSessions: sessions,
    audit,
    daemonId: 'daemon-1',
    generateConnSalt: () => fixedSalt(4),
    loopbackTransports: {
      openHttp: (args, handlers) => {
        requestArgs = args
        requestHandlers = handlers
        return { onData: () => {}, onEnd: () => {}, abort: () => {} }
      },
      openWs: () => {
        throw new Error('WebSocket transport should not be used')
      },
    },
  })
  bridge.attachSocket((frame) => outgoing.push(frame))

  const daemonSaltFrame = outgoing[0]
  if (!daemonSaltFrame) throw new Error('daemon salt was not emitted')
  const daemonSalt = decodeConnSalt(daemonSaltFrame.subarray(HEADER_BYTES)).salt
  const phoneSalt = fixedSalt(5)
  const phoneSaltHeader = encodeHeader({
    version: 2,
    kind: FrameKind.Data,
    flags: 0,
    streamId: CONN_SALT_STREAM_ID,
    seq: 0,
  })
  const phoneSaltBody = encodeConnSalt({ role: 'device', salt: phoneSalt })
  const phoneSaltFrame = new Uint8Array(HEADER_BYTES + phoneSaltBody.length)
  phoneSaltFrame.set(phoneSaltHeader)
  phoneSaltFrame.set(phoneSaltBody, HEADER_BYTES)
  bridge.onInbound(phoneSaltFrame)

  const connKeys = deriveConnectionKeys({
    rootD2p: fixedSalt(1),
    rootP2d: fixedSalt(2),
    phoneConnSalt: phoneSalt,
    daemonConnSalt: daemonSalt,
    ids: { daemonId: 'daemon-1', deviceId: 'device-1', protocolVersion: 2 },
  })
  const phoneSealer = createSealer('p2d')
  const openHeader = encodeHeader({
    version: 2,
    kind: FrameKind.Open,
    flags: 0,
    streamId: 1,
    seq: 0,
  })
  const openPayload = encodeOpenPayload({
    transport: StreamTransport.Http,
    http: {
      method: 'GET',
      path: '/api/remote/status',
      headers: [['origin', 'https://phone.invalid']],
      hasBody: false,
    },
  })
  const { ciphertext } = sealNext(phoneSealer, {
    key: connKeys.p2d,
    streamId: 1,
    headerBytes: openHeader,
    payload: openPayload,
  })
  const openFrame = new Uint8Array(HEADER_BYTES + ciphertext.length)
  openFrame.set(openHeader)
  openFrame.set(ciphertext, HEADER_BYTES)
  bridge.onInbound(openFrame)

  return {
    audit,
    bridge,
    connKeys,
    db,
    getRequestArgs: () => requestArgs,
    getRequestHandlers: () => requestHandlers,
    outgoing,
    phoneSealer,
  }
}

describe('remote frame bridge', () => {
  test('authenticates a device before opening an allowed loopback request', async () => {
    const { audit, connKeys, db, getRequestArgs, getRequestHandlers, outgoing } =
      createHttpBridgeHarness()

    expect(getRequestArgs()).toEqual({
      port: 4010,
      method: 'GET',
      path: '/api/remote/status',
      headers: {
        'x-hive-remote-secret': 'boot-secret',
        'x-hive-remote-device': 'device-1',
      },
    })
    const requestHandlers = getRequestHandlers()
    if (!requestHandlers) throw new Error('loopback request was not opened')

    requestHandlers.onHead({
      status: 200,
      headers: [
        ['set-cookie', 'hive_ui_token=must-not-leak'],
        ['content-type', 'application/json'],
      ],
    })
    requestHandlers.onEnd()
    await nextTick()

    const phoneOpener = createOpener('d2p')
    const encryptedResponses = outgoing.slice(2)
    expect(encryptedResponses).toHaveLength(2)
    const responseHead = encryptedResponses.map((frame) => {
      const headerBytes = frame.subarray(0, HEADER_BYTES)
      const header = decodeHeader(headerBytes)
      const plaintext = openNext(phoneOpener, {
        key: connKeys.d2p,
        streamId: header.streamId,
        headerBytes,
        ciphertext: frame.subarray(HEADER_BYTES),
        seq: header.seq,
      })
      return { header, plaintext }
    })
    const firstResponse = responseHead[0]
    const lastResponse = responseHead[1]
    if (!firstResponse || !lastResponse) throw new Error('incomplete response frame sequence')
    expect(decodeHttpData(firstResponse.plaintext)).toEqual({
      kind: 'head',
      head: { status: 200, headers: [['content-type', 'application/json']] },
    })
    expect(lastResponse.header.kind).toBe(FrameKind.End)

    await audit.flush()
    db.close()
  })

  test('backpressures large loopback responses until the phone acknowledges them', async () => {
    const { audit, bridge, connKeys, db, getRequestHandlers, outgoing, phoneSealer } =
      createHttpBridgeHarness()
    const requestHandlers = getRequestHandlers()
    if (!requestHandlers) throw new Error('loopback request was not opened')

    const body = Uint8Array.from({ length: 320 * 1024 }, (_, index) => index % 251)
    requestHandlers.onHead({ status: 200, headers: [['content-type', 'application/octet-stream']] })
    requestHandlers.onBody(body)
    requestHandlers.onEnd()
    await nextTick()

    const responseOpener = createOpener('d2p')
    const responseFramesBeforeAck = outgoing.slice(2)
    let responseBytesBeforeAck = 0
    const bodyBytes: Uint8Array[] = []
    let endSeenBeforeAck = false
    for (const frame of responseFramesBeforeAck) {
      const headerBytes = frame.subarray(0, HEADER_BYTES)
      const header = decodeHeader(headerBytes)
      const plaintext = openNext(responseOpener, {
        key: connKeys.d2p,
        streamId: header.streamId,
        headerBytes,
        ciphertext: frame.subarray(HEADER_BYTES),
        seq: header.seq,
      })
      if (header.kind === FrameKind.Data) {
        responseBytesBeforeAck += plaintext.length
        const data = decodeHttpData(plaintext)
        if (data.kind === 'body') bodyBytes.push(data.data)
      } else if (header.kind === FrameKind.End) {
        endSeenBeforeAck = true
      }
    }

    expect(responseBytesBeforeAck).toBeGreaterThan(0)
    expect(responseBytesBeforeAck).toBeLessThan(body.length)
    expect(endSeenBeforeAck).toBe(false)

    const ackHeader = encodeHeader({
      version: 2,
      kind: FrameKind.Ack,
      flags: 0,
      streamId: 1,
      seq: phoneSealer.nextSeq,
    })
    const { ciphertext: ackCiphertext } = sealNext(phoneSealer, {
      key: connKeys.p2d,
      streamId: 1,
      headerBytes: ackHeader,
      payload: encodeAckPayload(responseBytesBeforeAck),
    })
    const ackFrame = new Uint8Array(HEADER_BYTES + ackCiphertext.length)
    ackFrame.set(ackHeader)
    ackFrame.set(ackCiphertext, HEADER_BYTES)
    bridge.onInbound(ackFrame)
    await nextTick()

    const responseFramesAfterAck = outgoing.slice(2 + responseFramesBeforeAck.length)
    let endSeen = false
    for (const frame of responseFramesAfterAck) {
      const headerBytes = frame.subarray(0, HEADER_BYTES)
      const header = decodeHeader(headerBytes)
      const plaintext = openNext(responseOpener, {
        key: connKeys.d2p,
        streamId: header.streamId,
        headerBytes,
        ciphertext: frame.subarray(HEADER_BYTES),
        seq: header.seq,
      })
      if (header.kind === FrameKind.Data) {
        const data = decodeHttpData(plaintext)
        if (data.kind === 'body') bodyBytes.push(data.data)
      } else if (header.kind === FrameKind.End) {
        endSeen = true
      }
    }

    const receivedBody = new Uint8Array(bodyBytes.reduce((total, chunk) => total + chunk.length, 0))
    let offset = 0
    for (const chunk of bodyBytes) {
      receivedBody.set(chunk, offset)
      offset += chunk.length
    }
    expect(receivedBody).toEqual(body)
    expect(endSeen).toBe(true)

    await audit.flush()
    db.close()
  })
})
