import { describe, expect, test } from 'vitest'

import {
  createFlowController,
  createStreamIdAllocator,
  createStreamMachine,
  decodeHeader,
  decodeOpenPayload,
  encodeHeader,
  encodeOpenPayload,
  FrameKind,
  PROTOCOL_VERSION,
  ProtocolError,
  StreamTransport,
} from '../../src/shared/remote-protocol.js'

describe('remote protocol', () => {
  test('keeps the header canonical and round-trippable', () => {
    const encoded = encodeHeader({
      version: PROTOCOL_VERSION,
      kind: FrameKind.Data,
      flags: 1,
      streamId: 7,
      seq: 11,
    })
    expect(decodeHeader(encoded)).toEqual({
      version: PROTOCOL_VERSION,
      kind: FrameKind.Data,
      flags: 1,
      streamId: 7,
      seq: 11,
    })
    const badVersion = encoded.slice()
    badVersion[0] = 1
    expect(() => decodeHeader(badVersion)).toThrow(ProtocolError)
  })

  test('encodes HTTP stream metadata and rejects malformed payloads', () => {
    const payload = encodeOpenPayload({
      transport: StreamTransport.Http,
      http: {
        method: 'GET',
        path: '/api/workspaces',
        headers: [['accept', 'application/json']],
        hasBody: false,
      },
    })
    expect(decodeOpenPayload(payload)).toEqual({
      transport: StreamTransport.Http,
      http: {
        method: 'GET',
        path: '/api/workspaces',
        headers: [['accept', 'application/json']],
        hasBody: false,
      },
    })
    expect(() => decodeOpenPayload(payload.slice(0, -1))).toThrow(ProtocolError)
  })

  test('separates daemon and device stream ids', () => {
    const daemon = createStreamIdAllocator('daemon')
    const device = createStreamIdAllocator('device')
    expect([daemon(), daemon(), daemon()]).toEqual([2, 4, 6])
    expect([device(), device(), device()]).toEqual([1, 3, 5])
  })

  test('enforces stream lifecycle and flow control', () => {
    const stream = createStreamMachine()
    expect(stream.onRecv(FrameKind.Data)).toEqual({ ok: false, reset: 1 })
    expect(stream.onRecv(FrameKind.Open)).toEqual({ ok: true })
    expect(stream.onSendData()).toEqual({ ok: true })
    stream.onLocalEnd()
    expect(stream.onRecv(FrameKind.End)).toEqual({ ok: true })
    expect(stream.state()).toBe('closed')

    const flow = createFlowController(10, 4)
    expect(flow.trySend(10)).toEqual({ ok: true })
    expect(flow.isPaused()).toBe(true)
    expect(flow.trySend(1)).toEqual({ ok: false, reason: 'WindowExhausted' })
    expect(flow.applyAck(5)).toEqual({ resumed: true })
    expect(flow.trySend(5)).toEqual({ ok: true })
  })

  test('waits for cumulative acknowledgement before reserving a payload', async () => {
    const flow = createFlowController(10, 4)
    await flow.waitForWindow(10)

    let released = false
    const waiter = flow.waitForWindow(4).then(() => {
      released = true
    })
    await Promise.resolve()
    expect(released).toBe(false)

    expect(flow.applyAck(5)).toEqual({ resumed: true })
    await waiter
    expect(released).toBe(true)
    expect(flow.isPaused()).toBe(false)
  })
})
