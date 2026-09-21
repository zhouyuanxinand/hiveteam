import { createFrameBridge, type FrameBridgeContext } from '../../src/server/remote-frame-bridge.js'
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
  encodeConnSalt,
  encodeHeader,
  type FrameHeader,
  FrameKind,
  HEADER_BYTES,
} from '../../src/shared/remote-protocol.js'

/** Real encryption and daemon bridge; the gateway is only a byte transport in this fixture. */
export const createEncryptedRemoteClient = (context: FrameBridgeContext, deviceId: string) => {
  const session = context.deviceSessions.get(deviceId)
  if (!session) throw new Error('Missing fixture device session')
  const outgoing: Uint8Array[] = []
  const bridge = createFrameBridge(context)
  bridge.attachSocket((frame) => outgoing.push(frame))
  const saltFrame = outgoing[0]
  if (!saltFrame) throw new Error('No connection salt')
  const daemonConnSalt = decodeConnSalt(saltFrame.subarray(HEADER_BYTES)).salt
  const phoneConnSalt = crypto.getRandomValues(new Uint8Array(32))
  const handshakeHeader = encodeHeader({
    version: 2,
    kind: FrameKind.Data,
    flags: 0,
    streamId: CONN_SALT_STREAM_ID,
    seq: 0,
  })
  const handshakePayload = encodeConnSalt({ role: 'device', salt: phoneConnSalt })
  bridge.onInbound(Buffer.concat([handshakeHeader, handshakePayload]))
  const keys = deriveConnectionKeys({
    rootD2p: session.keys.d2p,
    rootP2d: session.keys.p2d,
    phoneConnSalt,
    daemonConnSalt,
    ids: { daemonId: context.daemonId, deviceId, protocolVersion: 2 },
  })
  const sealer = createSealer('p2d')
  const opener = createOpener('d2p')
  let cursor = outgoing.length
  const decoded: Array<{ header: FrameHeader; payload: Uint8Array }> = []
  return {
    bridge,
    send(streamId: number, kind: FrameHeader['kind'], payload: Uint8Array = new Uint8Array()) {
      const headerBytes = encodeHeader({
        version: 2,
        kind,
        flags: 0,
        streamId,
        seq: sealer.nextSeq,
      })
      const { ciphertext } = sealNext(sealer, { key: keys.p2d, streamId, headerBytes, payload })
      bridge.onInbound(Buffer.concat([headerBytes, ciphertext]))
    },
    read() {
      for (const frame of outgoing.slice(cursor)) {
        const headerBytes = frame.subarray(0, HEADER_BYTES)
        const header = decodeHeader(headerBytes)
        const payload = openNext(opener, {
          key: keys.d2p,
          streamId: header.streamId,
          headerBytes,
          ciphertext: frame.subarray(HEADER_BYTES),
          seq: header.seq,
        })
        decoded.push({ header, payload })
      }
      cursor = outgoing.length
      return decoded
    },
    close() {
      bridge.resetAllStreams('test complete')
    },
  }
}
