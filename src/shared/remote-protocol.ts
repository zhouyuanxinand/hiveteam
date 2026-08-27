import { REMOTE_CRYPTO_VERSION } from './remote-crypto.js'

export { REMOTE_CRYPTO_VERSION as PROTOCOL_VERSION } from './remote-crypto.js'

export const FrameKind = {
  Open: 0x01,
  Data: 0x02,
  End: 0x03,
  Reset: 0x04,
  Ping: 0x05,
  Ack: 0x06,
} as const
export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind]

export const StreamTransport = { Http: 0x01, Ws: 0x02 } as const
export type StreamTransport = (typeof StreamTransport)[keyof typeof StreamTransport]

export const ResetCode = {
  Normal: 0x00,
  ProtocolError: 0x01,
  FlowViolation: 0x02,
  StreamRefused: 0x03,
  VersionMismatch: 0x04,
  InternalError: 0x05,
} as const
export type ResetCode = (typeof ResetCode)[keyof typeof ResetCode]

export const FLOW = { INITIAL_WINDOW: 256 * 1024, ACK_THRESHOLD: 32 * 1024 } as const
export const HEADER_BYTES = 12
export const CHANNEL_STREAM_ID = 0
export const CONN_SALT_STREAM_ID = 0xffffffff
const FLAG_FIN = 0x0001

export class ProtocolError extends Error {
  constructor(
    message: string,
    public readonly code: ResetCode
  ) {
    super(message)
    this.name = 'ProtocolError'
  }
}

export interface FrameHeader {
  version: number
  kind: FrameKind
  flags: number
  streamId: number
  seq: number
}

const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

const assertU32 = (value: number, name: string) => {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${name} out of u32 range: ${value}`)
  }
}

const isFrameKind = (value: number): value is FrameKind =>
  Object.values(FrameKind).includes(value as FrameKind)

const isResetCode = (value: number): value is ResetCode =>
  Object.values(ResetCode).includes(value as ResetCode)

export const isReservedFlagsClear = (flags: number) => (flags & ~FLAG_FIN) === 0

export function encodeHeader(header: FrameHeader): Uint8Array {
  if (header.version !== REMOTE_CRYPTO_VERSION) {
    throw new RangeError(`version must be ${REMOTE_CRYPTO_VERSION}`)
  }
  if (!isFrameKind(header.kind)) throw new RangeError(`unknown kind: ${header.kind}`)
  if (!Number.isInteger(header.flags) || header.flags < 0 || header.flags > 0xffff) {
    throw new RangeError(`flags out of u16 range: ${header.flags}`)
  }
  if (header.kind === FrameKind.Data) {
    if (!isReservedFlagsClear(header.flags))
      throw new RangeError('reserved flag bits set on Data frame')
  } else if (header.flags !== 0) {
    throw new RangeError('flags must be 0 on a non-Data frame')
  }
  assertU32(header.streamId, 'streamId')
  assertU32(header.seq, 'seq')
  const output = new Uint8Array(HEADER_BYTES)
  const view = viewOf(output)
  view.setUint8(0, header.version)
  view.setUint8(1, header.kind)
  view.setUint16(2, header.flags)
  view.setUint32(4, header.streamId)
  view.setUint32(8, header.seq)
  return output
}

export function decodeHeader(bytes: Uint8Array): FrameHeader {
  if (bytes.length < HEADER_BYTES)
    throw new ProtocolError('header too short', ResetCode.ProtocolError)
  const view = viewOf(bytes)
  const version = view.getUint8(0)
  if (version !== REMOTE_CRYPTO_VERSION) {
    throw new ProtocolError(`bad version ${version}`, ResetCode.VersionMismatch)
  }
  const kind = view.getUint8(1)
  if (!isFrameKind(kind)) throw new ProtocolError(`unknown kind ${kind}`, ResetCode.ProtocolError)
  const flags = view.getUint16(2)
  if (kind === FrameKind.Data) {
    if (!isReservedFlagsClear(flags)) {
      throw new ProtocolError('reserved flag bits set on Data frame', ResetCode.ProtocolError)
    }
  } else if (flags !== 0) {
    throw new ProtocolError('flags must be 0 on a non-Data frame', ResetCode.ProtocolError)
  }
  return {
    version,
    kind,
    flags,
    streamId: view.getUint32(4),
    seq: view.getUint32(8),
  }
}

export interface StreamMeta {
  transport: StreamTransport
  http?: {
    method: string
    path: string
    headers: [string, string][]
    hasBody: boolean
  }
  ws?: {
    path: string
    query?: [string, string][]
    subprotocol?: string
  }
}

export interface HelloMeta {
  protocolVersion: number
  role: 'daemon' | 'device'
  daemonId: string
  deviceId: string
}

export interface HttpResponseHead {
  status: number
  headers: [string, string][]
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()
const isHeaderList = (value: unknown): value is [string, string][] =>
  Array.isArray(value) &&
  value.every(
    (pair) =>
      Array.isArray(pair) &&
      pair.length === 2 &&
      typeof pair[0] === 'string' &&
      typeof pair[1] === 'string'
  )

export function encodeOpenPayload(meta: StreamMeta): Uint8Array {
  let transportMeta: object
  if (meta.transport === StreamTransport.Http) {
    if (!meta.http) throw new RangeError('http meta required for Http transport')
    transportMeta = meta.http
  } else if (meta.transport === StreamTransport.Ws) {
    if (!meta.ws) throw new RangeError('ws meta required for Ws transport')
    transportMeta = meta.ws
  } else {
    throw new RangeError(`unknown transport: ${meta.transport}`)
  }
  const encoded = textEncoder.encode(JSON.stringify(transportMeta))
  if (encoded.length > 0xffff) throw new RangeError('open meta too large')
  const output = new Uint8Array(3 + encoded.length)
  output[0] = meta.transport
  viewOf(output).setUint16(1, encoded.length)
  output.set(encoded, 3)
  return output
}

export function decodeOpenPayload(payload: Uint8Array): StreamMeta {
  if (payload.length < 3) throw new ProtocolError('open payload too short', ResetCode.ProtocolError)
  const transport = payload[0]
  const metaLength = viewOf(payload).getUint16(1)
  if (payload.length !== 3 + metaLength) {
    throw new ProtocolError('open meta length mismatch', ResetCode.ProtocolError)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(textDecoder.decode(payload.subarray(3)))
  } catch {
    throw new ProtocolError('open meta not JSON', ResetCode.ProtocolError)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ProtocolError('open meta must be an object', ResetCode.ProtocolError)
  }
  const raw = parsed as Record<string, unknown>
  if (transport === StreamTransport.Http) {
    if (
      typeof raw.method !== 'string' ||
      typeof raw.path !== 'string' ||
      typeof raw.hasBody !== 'boolean' ||
      !isHeaderList(raw.headers)
    ) {
      throw new ProtocolError('bad http open meta', ResetCode.ProtocolError)
    }
    return {
      transport: StreamTransport.Http,
      http: { method: raw.method, path: raw.path, headers: raw.headers, hasBody: raw.hasBody },
    }
  }
  if (transport === StreamTransport.Ws) {
    if (typeof raw.path !== 'string')
      throw new ProtocolError('bad ws open meta', ResetCode.ProtocolError)
    if (raw.subprotocol !== undefined && typeof raw.subprotocol !== 'string') {
      throw new ProtocolError('bad ws subprotocol', ResetCode.ProtocolError)
    }
    if (raw.query !== undefined && !isHeaderList(raw.query)) {
      throw new ProtocolError('bad ws query', ResetCode.ProtocolError)
    }
    const ws: NonNullable<StreamMeta['ws']> = { path: raw.path }
    if (isHeaderList(raw.query)) ws.query = raw.query
    if (typeof raw.subprotocol === 'string') ws.subprotocol = raw.subprotocol
    return { transport: StreamTransport.Ws, ws }
  }
  throw new ProtocolError(`unknown transport ${transport}`, ResetCode.ProtocolError)
}

export const CHANNEL_DISC = { ConnSalt: 0x01, Hello: 0x02 } as const
export type ChannelDisc = (typeof CHANNEL_DISC)[keyof typeof CHANNEL_DISC]
const CONN_SALT_ROLE = { daemon: 0x01, device: 0x02 } as const

export interface ConnSaltMsg {
  role: 'daemon' | 'device'
  salt: Uint8Array
}

export function encodeConnSalt(message: ConnSaltMsg): Uint8Array {
  if (message.role !== 'daemon' && message.role !== 'device') throw new RangeError('bad role')
  if (message.salt.length !== 32) throw new RangeError('conn salt must be 32 bytes')
  const output = new Uint8Array(34)
  output[0] = CHANNEL_DISC.ConnSalt
  output[1] = CONN_SALT_ROLE[message.role]
  output.set(message.salt, 2)
  return output
}

export function decodeConnSalt(payload: Uint8Array): ConnSaltMsg {
  if (payload.length !== 34)
    throw new ProtocolError('conn salt must be 34 bytes', ResetCode.ProtocolError)
  if (payload[0] !== CHANNEL_DISC.ConnSalt) {
    throw new ProtocolError('not a ConnSalt frame', ResetCode.ProtocolError)
  }
  const role = payload[1] === 1 ? 'daemon' : payload[1] === 2 ? 'device' : null
  if (role === null) throw new ProtocolError('bad conn salt role', ResetCode.ProtocolError)
  return { role, salt: payload.slice(2) }
}

export const isConnSaltPayload = (payload: Uint8Array) =>
  payload.length >= 1 && payload[0] === CHANNEL_DISC.ConnSalt

export function encodeHello(meta: HelloMeta): Uint8Array {
  if (meta.role !== 'daemon' && meta.role !== 'device') throw new RangeError('bad role')
  const encoded = textEncoder.encode(JSON.stringify(meta))
  const output = new Uint8Array(1 + encoded.length)
  output[0] = CHANNEL_DISC.Hello
  output.set(encoded, 1)
  return output
}

export function decodeHello(payload: Uint8Array): HelloMeta {
  if (payload.length < 1 || payload[0] !== CHANNEL_DISC.Hello) {
    throw new ProtocolError('hello missing disc', ResetCode.ProtocolError)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(textDecoder.decode(payload.subarray(1)))
  } catch {
    throw new ProtocolError('hello not JSON', ResetCode.ProtocolError)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ProtocolError('bad hello meta', ResetCode.ProtocolError)
  }
  const raw = parsed as Record<string, unknown>
  if (
    typeof raw.protocolVersion !== 'number' ||
    (raw.role !== 'daemon' && raw.role !== 'device') ||
    typeof raw.daemonId !== 'string' ||
    typeof raw.deviceId !== 'string'
  ) {
    throw new ProtocolError('bad hello meta', ResetCode.ProtocolError)
  }
  return {
    protocolVersion: raw.protocolVersion,
    role: raw.role,
    daemonId: raw.daemonId,
    deviceId: raw.deviceId,
  }
}

export function encodeAckPayload(cumulativeBytes: number): Uint8Array {
  assertU32(cumulativeBytes, 'cumulativeBytes')
  const output = new Uint8Array(4)
  viewOf(output).setUint32(0, cumulativeBytes)
  return output
}

export function decodeAckPayload(payload: Uint8Array): number {
  if (payload.length !== 4)
    throw new ProtocolError('ack payload must be 4 bytes', ResetCode.ProtocolError)
  return viewOf(payload).getUint32(0)
}

export function encodeResetPayload(code: ResetCode): Uint8Array {
  if (!isResetCode(code)) throw new RangeError(`unknown reset code: ${code}`)
  return Uint8Array.of(code)
}

export function decodeResetPayload(payload: Uint8Array): ResetCode {
  if (payload.length !== 1)
    throw new ProtocolError('reset payload must be 1 byte', ResetCode.ProtocolError)
  const code = payload[0]
  if (code === undefined || !isResetCode(code)) {
    throw new ProtocolError(`unknown reset code ${code}`, ResetCode.ProtocolError)
  }
  return code
}

export function encodeWsMessage(data: Uint8Array, isText: boolean): Uint8Array {
  const output = new Uint8Array(1 + data.length)
  output[0] = isText ? 1 : 0
  output.set(data, 1)
  return output
}

export function decodeWsMessage(payload: Uint8Array): { data: Uint8Array; isText: boolean } {
  if (payload.length < 1) throw new ProtocolError('ws message too short', ResetCode.ProtocolError)
  if (payload[0] !== 0 && payload[0] !== 1) {
    throw new ProtocolError('bad ws isText flag', ResetCode.ProtocolError)
  }
  return { data: payload.slice(1), isText: payload[0] === 1 }
}

export function encodeHttpHead(head: HttpResponseHead): Uint8Array {
  if (!Number.isInteger(head.status) || head.status < 0 || head.status > 0xffff) {
    throw new RangeError(`bad http status: ${head.status}`)
  }
  const encoded = textEncoder.encode(JSON.stringify({ status: head.status, headers: head.headers }))
  const output = new Uint8Array(1 + encoded.length)
  output[0] = 0
  output.set(encoded, 1)
  return output
}

export function encodeHttpBodyChunk(body: Uint8Array): Uint8Array {
  const output = new Uint8Array(1 + body.length)
  output[0] = 1
  output.set(body, 1)
  return output
}

export function decodeHttpData(payload: Uint8Array) {
  if (payload.length < 1) throw new ProtocolError('http data too short', ResetCode.ProtocolError)
  if (payload[0] === 0) {
    let parsed: unknown
    try {
      parsed = JSON.parse(textDecoder.decode(payload.subarray(1)))
    } catch {
      throw new ProtocolError('http head not JSON', ResetCode.ProtocolError)
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new ProtocolError('bad http head', ResetCode.ProtocolError)
    }
    const raw = parsed as Record<string, unknown>
    if (typeof raw.status !== 'number' || !isHeaderList(raw.headers)) {
      throw new ProtocolError('bad http head', ResetCode.ProtocolError)
    }
    return { kind: 'head' as const, head: { status: raw.status, headers: raw.headers } }
  }
  if (payload[0] === 1) return { kind: 'body' as const, data: payload.slice(1) }
  throw new ProtocolError(`unknown http disc ${payload[0]}`, ResetCode.ProtocolError)
}

export function createStreamIdAllocator(side: 'daemon' | 'device'): () => number {
  if (side !== 'daemon' && side !== 'device') throw new RangeError(`bad side: ${side}`)
  let next = side === 'daemon' ? 2 : 1
  return () => {
    if (next === CONN_SALT_STREAM_ID) next += 2
    const result = next
    next += 2
    if (next > 0xffffffff) throw new RangeError('stream id space exhausted; re-handshake required')
    return result
  }
}

export type StreamState = 'idle' | 'open' | 'localClosed' | 'remoteClosed' | 'closed'

export interface StreamMachine {
  state(): StreamState
  onRecv(kind: FrameKind): { ok: true } | { ok: false; reset: ResetCode }
  onSendData(): { ok: true } | { ok: false; reset: ResetCode }
  onLocalEnd(): void
  onReset(): void
}

const accepted = { ok: true } as const
const rejected = { ok: false as const, reset: ResetCode.ProtocolError }

export function createStreamMachine(): StreamMachine {
  let current: StreamState = 'idle'
  return {
    state: () => current,
    onRecv(kind) {
      if (kind === FrameKind.Reset) {
        current = 'closed'
        return accepted
      }
      if (current === 'idle') {
        if (kind === FrameKind.Open) {
          current = 'open'
          return accepted
        }
        return rejected
      }
      if (current === 'open') {
        if (kind === FrameKind.Data) return accepted
        if (kind === FrameKind.End) {
          current = 'remoteClosed'
          return accepted
        }
        return rejected
      }
      if (current === 'localClosed') {
        if (kind === FrameKind.Data) return accepted
        if (kind === FrameKind.End) {
          current = 'closed'
          return accepted
        }
      }
      return rejected
    },
    onSendData: () => (current === 'open' || current === 'remoteClosed' ? accepted : rejected),
    onLocalEnd() {
      if (current === 'open') current = 'localClosed'
      else if (current === 'remoteClosed') current = 'closed'
    },
    onReset: () => {
      current = 'closed'
    },
  }
}

export interface FlowController {
  trySend(n: number): { ok: true } | { ok: false; reason: 'WindowExhausted' }
  /** Wait for peer credit and reserve the bytes when credit is available. */
  waitForWindow(n: number): Promise<void>
  applyAck(cumulativeBytes: number): { resumed: boolean }
  onConsume(n: number): { ackCumulative: number } | null
  flushAck(): { ackCumulative: number }
  isPaused(): boolean
  cancel(error?: Error): void
}

export function createFlowController(
  window = FLOW.INITIAL_WINDOW,
  ackThreshold = FLOW.ACK_THRESHOLD
): FlowController {
  let sentBytes = 0
  let acknowledged = 0
  let consumed = 0
  let lastAckedAt = 0
  let cancelled: Error | null = null
  const waiters: Array<{
    bytes: number
    reject: (error: Error) => void
    resolve: () => void
  }> = []
  const isPaused = () => sentBytes - acknowledged >= window
  const trySend = (bytes: number) => {
    if (cancelled || sentBytes - acknowledged + bytes > window) {
      return { ok: false as const, reason: 'WindowExhausted' as const }
    }
    sentBytes += bytes
    return accepted
  }
  const flushWaiters = () => {
    while (waiters.length > 0) {
      const waiter = waiters[0]
      if (!waiter) break
      const result = trySend(waiter.bytes)
      if (!result.ok) break
      waiters.shift()
      waiter.resolve()
    }
  }
  return {
    trySend,
    waitForWindow(bytes) {
      if (!Number.isFinite(bytes) || bytes < 0 || bytes > window) {
        return Promise.reject(new RangeError(`flow payload exceeds window: ${bytes}`))
      }
      if (cancelled) return Promise.reject(cancelled)
      if (trySend(bytes).ok) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        waiters.push({ bytes, reject, resolve })
      })
    },
    applyAck(cumulativeBytes) {
      const wasPaused = isPaused()
      if (cumulativeBytes <= acknowledged) return { resumed: false }
      acknowledged = Math.min(cumulativeBytes, sentBytes)
      flushWaiters()
      return { resumed: wasPaused && !isPaused() }
    },
    onConsume(bytes) {
      consumed += bytes
      if (consumed - lastAckedAt < ackThreshold) return null
      lastAckedAt = consumed
      return { ackCumulative: consumed }
    },
    flushAck() {
      lastAckedAt = consumed
      return { ackCumulative: consumed }
    },
    isPaused,
    cancel(error = new Error('flow cancelled')) {
      if (cancelled) return
      cancelled = error
      for (const waiter of waiters.splice(0)) waiter.reject(error)
    },
  }
}

export function negotiateVersion(
  _localHello: HelloMeta,
  peerHello: HelloMeta
): { ok: true; version: number } | { ok: false; reset: ResetCode } {
  return peerHello.protocolVersion === REMOTE_CRYPTO_VERSION
    ? { ok: true, version: REMOTE_CRYPTO_VERSION }
    : { ok: false, reset: ResetCode.VersionMismatch }
}
