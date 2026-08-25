import { request as httpRequest } from 'node:http'

import WebSocketClient from 'ws'

import { classifyOpen } from '../shared/remote-bridge-routing.js'
import {
  createOpener,
  createSealer,
  deriveConnectionKeys,
  generateConnSalt,
  openNext,
  REMOTE_CRYPTO_VERSION,
  sealNext,
} from '../shared/remote-crypto.js'
import {
  CHANNEL_STREAM_ID,
  CONN_SALT_STREAM_ID,
  createFlowController,
  createStreamMachine,
  decodeConnSalt,
  decodeHeader,
  decodeHttpData,
  decodeOpenPayload,
  decodeWsMessage,
  encodeConnSalt,
  encodeHeader,
  encodeHttpBodyChunk,
  encodeHttpHead,
  encodeResetPayload,
  encodeWsMessage,
  type FrameHeader,
  FrameKind,
  HEADER_BYTES,
  isConnSaltPayload,
  ResetCode,
  type StreamMeta,
} from '../shared/remote-protocol.js'
import type { RemoteAuditStore } from './remote-audit-store.js'
import type { DeviceSession, DeviceSessionProvider } from './remote-device-session.js'
import { DAEMON_OPEN_DIRECTION, DAEMON_SEAL_DIRECTION } from './remote-device-session.js'
import { sanitizeTunnelResponseHeaders, stampLoopbackHeaders } from './remote-loopback-auth.js'

export interface LoopbackHttpRequest {
  onData: (chunk: Uint8Array) => void
  onEnd: () => void
  abort: () => void
}

export interface LoopbackHttpHandlers {
  onHead: (head: { status: number; headers: [string, string][] }) => void
  onBody: (chunk: Uint8Array) => void
  onEnd: () => void
  onError: (error: Error) => void
}

export interface LoopbackWsConnection {
  onData: (data: Uint8Array, isText: boolean) => void
  onClose: () => void
  abort: () => void
}

export interface LoopbackWsHandlers {
  onOpen: () => void
  onMessage: (data: Uint8Array, isText: boolean) => void
  onClose: () => void
  onError: (error: Error) => void
}

export interface LoopbackTransports {
  openHttp: (
    args: { port: number; method: string; path: string; headers: Record<string, string> },
    handlers: LoopbackHttpHandlers
  ) => LoopbackHttpRequest
  openWs: (
    args: { port: number; path: string; headers: Record<string, string> },
    handlers: LoopbackWsHandlers
  ) => LoopbackWsConnection
}

export interface FrameBridgeContext {
  loopbackPort: number
  loopbackSecret: string
  deviceSessions: DeviceSessionProvider
  audit: RemoteAuditStore
  daemonId: string
  loopbackTransports?: LoopbackTransports
  generateConnSalt?: () => Uint8Array
  onSeal?: (event: { key: Uint8Array; direction: 'd2p' | 'p2d'; headerBytes: Uint8Array }) => void
}

export interface FrameBridge {
  attachSocket: (send: (frame: Uint8Array) => void) => void
  onInbound: (frame: ArrayBuffer | Uint8Array) => void
  resetAllStreams: (reason: string, options?: { keepSink?: boolean }) => void
  closeDevice: (deviceId: string, reason: string) => void
}

type DeviceState = {
  session: DeviceSession
  connKeys: { d2p: Uint8Array; p2d: Uint8Array }
  phoneConnSalt: Uint8Array
  opener: ReturnType<typeof createOpener>
  sealer: ReturnType<typeof createSealer>
}

type StreamState = {
  deviceId: string
  transport: 'http' | 'ws'
  path: string
  machine: ReturnType<typeof createStreamMachine>
  recvFlow: ReturnType<typeof createFlowController>
  sendFlow: ReturnType<typeof createFlowController>
  closed: boolean
  http?: LoopbackHttpRequest
  ws?: LoopbackWsConnection
  ioAckControl?: LoopbackWsConnection
  pendingSelfAck: number
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()
const TERMINAL_IO_RE = /^\/ws\/terminal\/([^/?]+)\/io$/
const LOOPBACK_WS_PENDING_BYTES_LIMIT = 256 * 1024

const bytesEqual = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((value, index) => value === right[index])

const streamKey = (deviceId: string, streamId: number) => `${deviceId}\0${streamId}`
const streamIdFromKey = (key: string) => Number(key.slice(key.indexOf('\0') + 1))

const appendQuery = (path: string, query?: [string, string][]) => {
  if (!query || query.length === 0) return path
  return `${path}?${query
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')}`
}

const terminalControlPath = (ioPath: string) => {
  const match = TERMINAL_IO_RE.exec(ioPath)
  return match?.[1] ? `/ws/terminal/${match[1]}/control` : null
}

const realLoopbackTransports: LoopbackTransports = {
  openHttp(args, handlers) {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: args.port,
        method: args.method,
        path: args.path,
        headers: args.headers,
      },
      (response) => {
        const rawHeaders = response.rawHeaders
        const headers: [string, string][] = []
        for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
          const name = rawHeaders[index]
          const value = rawHeaders[index + 1]
          if (name !== undefined && value !== undefined) headers.push([name, value])
        }
        handlers.onHead({ status: response.statusCode ?? 0, headers })
        response.on('data', (chunk: Buffer) => handlers.onBody(new Uint8Array(chunk)))
        response.on('end', handlers.onEnd)
        response.on('error', handlers.onError)
      }
    )
    request.on('error', handlers.onError)
    return {
      onData: (chunk) => request.write(Buffer.from(chunk)),
      onEnd: () => request.end(),
      abort: () => request.destroy(),
    }
  },
  openWs(args, handlers) {
    const socket = new WebSocketClient(`ws://127.0.0.1:${args.port}${args.path}`, {
      headers: args.headers,
    })
    let closed = false
    let pendingBytes = 0
    const pending: Array<{ data: Uint8Array; isText: boolean }> = []
    const sendNow = (data: Uint8Array, isText: boolean) => {
      socket.send(Buffer.from(data), { binary: !isText }, (error) => {
        if (error) handlers.onError(error)
      })
    }
    const flushPending = () => {
      for (const item of pending.splice(0)) {
        if (closed || socket.readyState !== WebSocketClient.OPEN) break
        sendNow(item.data, item.isText)
      }
      pendingBytes = 0
    }
    socket.binaryType = 'arraybuffer'
    socket.on('open', () => {
      handlers.onOpen()
      flushPending()
    })
    socket.on('message', (data, isBinary) => {
      const buffer = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data)
      handlers.onMessage(new Uint8Array(buffer), !isBinary)
    })
    socket.on('close', () => {
      closed = true
      pending.length = 0
      pendingBytes = 0
      handlers.onClose()
    })
    socket.on('error', handlers.onError)
    return {
      onData: (data, isText) => {
        if (closed) return
        if (socket.readyState === WebSocketClient.OPEN) {
          sendNow(data, isText)
          return
        }
        if (socket.readyState !== WebSocketClient.CONNECTING) return
        pendingBytes += data.byteLength
        if (pendingBytes > LOOPBACK_WS_PENDING_BYTES_LIMIT) {
          closed = true
          pending.length = 0
          pendingBytes = 0
          handlers.onError(new Error('loopback websocket pending buffer exceeded'))
          try {
            socket.terminate()
          } catch {
            // The socket is already gone.
          }
          return
        }
        pending.push({ data: Uint8Array.from(data), isText })
      },
      onClose: () => {
        closed = true
        pending.length = 0
        pendingBytes = 0
        socket.close()
      },
      abort: () => {
        closed = true
        pending.length = 0
        pendingBytes = 0
        socket.terminate()
      },
    }
  },
}

export const createFrameBridge = (ctx: FrameBridgeContext): FrameBridge => {
  const transports = ctx.loopbackTransports ?? realLoopbackTransports
  const generateSalt = ctx.generateConnSalt ?? generateConnSalt
  let send: ((frame: Uint8Array) => void) | null = null
  let daemonConnSalt: Uint8Array | null = null
  const pendingPhoneSalts: Uint8Array[] = []
  const devices = new Map<string, DeviceState>()
  const retiredPhoneSalts = new Map<string, Uint8Array[]>()
  const streams = new Map<string, StreamState>()
  const streamOwners = new Map<number, string>()

  const rememberPhoneSalt = (salt: Uint8Array) => {
    const existing = pendingPhoneSalts.findIndex((item) => bytesEqual(item, salt))
    if (existing >= 0) pendingPhoneSalts.splice(existing, 1)
    pendingPhoneSalts.unshift(Uint8Array.from(salt))
    pendingPhoneSalts.splice(16)
  }

  const emitDaemonSalt = () => {
    if (!send || !daemonConnSalt) return
    const header = encodeHeader({
      version: REMOTE_CRYPTO_VERSION,
      kind: FrameKind.Data,
      flags: 0,
      streamId: CONN_SALT_STREAM_ID,
      seq: 0,
    })
    const body = encodeConnSalt({ role: 'daemon', salt: daemonConnSalt })
    const frame = new Uint8Array(header.length + body.length)
    frame.set(header)
    frame.set(body, header.length)
    send(frame)
  }

  const deriveDeviceState = (session: DeviceSession, phoneConnSalt: Uint8Array) => {
    if (!daemonConnSalt) return null
    return {
      session,
      connKeys: deriveConnectionKeys({
        rootD2p: session.keys.d2p,
        rootP2d: session.keys.p2d,
        phoneConnSalt,
        daemonConnSalt,
        ids: {
          daemonId: ctx.daemonId,
          deviceId: session.deviceId,
          protocolVersion: REMOTE_CRYPTO_VERSION,
        },
      }),
      phoneConnSalt,
      opener: createOpener(DAEMON_OPEN_DIRECTION),
      sealer: createSealer(DAEMON_SEAL_DIRECTION),
    } satisfies DeviceState
  }

  const sendFrame = (
    state: DeviceState,
    kind: (typeof FrameKind)[keyof typeof FrameKind],
    streamId: number,
    payload: Uint8Array,
    flags = 0
  ) => {
    if (!send) return
    const headerBytes = encodeHeader({
      version: REMOTE_CRYPTO_VERSION,
      kind,
      flags,
      streamId,
      seq: state.sealer.nextSeq,
    })
    ctx.onSeal?.({
      key: state.connKeys[DAEMON_SEAL_DIRECTION],
      direction: DAEMON_SEAL_DIRECTION,
      headerBytes,
    })
    const { ciphertext } = sealNext(state.sealer, {
      key: state.connKeys[DAEMON_SEAL_DIRECTION],
      streamId,
      headerBytes,
      payload,
    })
    const frame = new Uint8Array(headerBytes.length + ciphertext.length)
    frame.set(headerBytes)
    frame.set(ciphertext, headerBytes.length)
    send(frame)
  }

  const sendReset = (state: DeviceState, streamId: number, code: ResetCode) => {
    sendFrame(state, FrameKind.Reset, streamId, encodeResetPayload(code))
  }

  const removeStream = (key: string, mode: 'abort' | 'close' = 'abort') => {
    const stream = streams.get(key)
    if (!stream) return
    stream.closed = true
    if (stream.http) stream.http.abort()
    if (stream.ws) mode === 'close' ? stream.ws.onClose() : stream.ws.abort()
    if (stream.ioAckControl)
      mode === 'close' ? stream.ioAckControl.onClose() : stream.ioAckControl.abort()
    streams.delete(key)
    const streamId = streamIdFromKey(key)
    if (streamOwners.get(streamId) === stream.deviceId) streamOwners.delete(streamId)
  }

  const removeDeviceStreams = (deviceId: string) => {
    for (const [key, stream] of streams) {
      if (stream.deviceId === deviceId) removeStream(key)
    }
  }

  const sendOutputAck = (stream: StreamState, count: number) => {
    if (!stream.ioAckControl || count <= 0) return
    stream.ioAckControl.onData(
      textEncoder.encode(JSON.stringify({ type: 'output_ack', bytes: count })),
      true
    )
  }

  const resolveAndOpen = (
    streamId: number,
    seq: number,
    headerBytes: Uint8Array,
    ciphertext: Uint8Array
  ): { state: DeviceState; plaintext: Uint8Array } | null => {
    const tryOpen = (state: DeviceState) => {
      try {
        return openNext(state.opener, {
          key: state.connKeys[DAEMON_OPEN_DIRECTION],
          streamId,
          headerBytes,
          ciphertext,
          seq,
        })
      } catch {
        return null
      }
    }

    const boundDeviceId = streamOwners.get(streamId)
    const bound = boundDeviceId ? devices.get(boundDeviceId) : undefined
    const boundPlaintext = bound ? tryOpen(bound) : null
    if (bound && boundPlaintext) return { state: bound, plaintext: boundPlaintext }

    for (const state of devices.values()) {
      if (state.session.deviceId === boundDeviceId) continue
      const plaintext = tryOpen(state)
      if (plaintext) {
        if (streamId !== CHANNEL_STREAM_ID) streamOwners.set(streamId, state.session.deviceId)
        return { state, plaintext }
      }
    }

    if (!daemonConnSalt || pendingPhoneSalts.length === 0) return null
    for (const session of ctx.deviceSessions.candidates()) {
      const existing = devices.get(session.deviceId)
      for (const phoneSalt of pendingPhoneSalts) {
        if (existing && bytesEqual(existing.phoneConnSalt, phoneSalt)) continue
        const retired = retiredPhoneSalts.get(session.deviceId) ?? []
        if (retired.some((salt) => bytesEqual(salt, phoneSalt))) continue
        const candidate = deriveDeviceState(session, phoneSalt)
        if (!candidate) continue
        const plaintext = tryOpen(candidate)
        if (!plaintext) continue
        if (existing) {
          const old = retiredPhoneSalts.get(session.deviceId) ?? []
          old.unshift(Uint8Array.from(existing.phoneConnSalt))
          old.splice(16)
          retiredPhoneSalts.set(session.deviceId, old)
          removeDeviceStreams(session.deviceId)
        }
        devices.set(session.deviceId, candidate)
        if (streamId !== CHANNEL_STREAM_ID) streamOwners.set(streamId, session.deviceId)
        return { state: candidate, plaintext }
      }
    }
    return null
  }

  const onOpenFrame = (state: DeviceState, streamId: number, plaintext: Uint8Array) => {
    let meta: StreamMeta
    try {
      meta = decodeOpenPayload(plaintext)
    } catch {
      sendReset(state, streamId, ResetCode.ProtocolError)
      ctx.audit.enqueue({
        action: 'reject',
        result: 'rejected',
        rejectReason: 'malformed_meta',
        deviceId: state.session.deviceId,
      })
      return
    }
    const decision = classifyOpen(meta)
    if (!decision.ok) {
      sendReset(state, streamId, ResetCode.StreamRefused)
      ctx.audit.enqueue({
        action: 'reject',
        result: 'rejected',
        rejectReason: decision.reason,
        endpoint: meta.http?.path ?? meta.ws?.path ?? null,
        deviceId: state.session.deviceId,
      })
      return
    }

    const key = streamKey(state.session.deviceId, streamId)
    const stream: StreamState = {
      deviceId: state.session.deviceId,
      transport: decision.transport,
      path: decision.path,
      machine: createStreamMachine(),
      recvFlow: createFlowController(),
      sendFlow: createFlowController(),
      closed: false,
      pendingSelfAck: 0,
    }
    stream.machine.onRecv(FrameKind.Open)
    streams.set(key, stream)

    const headers = stampLoopbackHeaders(
      meta.http?.headers ?? [],
      ctx.loopbackSecret,
      state.session.deviceId
    )
    if (decision.transport === 'http') {
      stream.http = transports.openHttp(
        { port: ctx.loopbackPort, method: decision.method, path: decision.path, headers },
        {
          onHead: (head) => {
            if (stream.closed) return
            sendFrame(
              state,
              FrameKind.Data,
              streamId,
              encodeHttpHead({
                status: head.status,
                headers: sanitizeTunnelResponseHeaders(head.headers),
              })
            )
          },
          onBody: (chunk) => {
            if (!stream.closed)
              sendFrame(state, FrameKind.Data, streamId, encodeHttpBodyChunk(chunk))
          },
          onEnd: () => {
            if (stream.closed) return
            sendFrame(state, FrameKind.End, streamId, new Uint8Array())
            ctx.audit.enqueue({
              action: 'http',
              result: 'ok',
              endpoint: stream.path,
              deviceId: state.session.deviceId,
            })
            removeStream(key, 'close')
          },
          onError: () => {
            if (stream.closed) return
            sendReset(state, streamId, ResetCode.InternalError)
            ctx.audit.enqueue({
              action: 'http',
              result: 'error',
              endpoint: stream.path,
              deviceId: state.session.deviceId,
            })
            removeStream(key)
          },
        }
      )
      return
    }

    const wsPath = appendQuery(decision.path, decision.query)
    const controlPath = terminalControlPath(decision.path)
    if (controlPath) {
      stream.ioAckControl = transports.openWs(
        { port: ctx.loopbackPort, path: appendQuery(controlPath, decision.query), headers },
        { onOpen: () => {}, onMessage: () => {}, onClose: () => {}, onError: () => {} }
      )
    }
    stream.ws = transports.openWs(
      { port: ctx.loopbackPort, path: wsPath, headers },
      {
        onOpen: () =>
          ctx.audit.enqueue({
            action: 'ws_open',
            result: 'ok',
            endpoint: stream.path,
            deviceId: state.session.deviceId,
          }),
        onMessage: (data, isText) => {
          if (stream.closed) return
          const fits = stream.sendFlow.trySend(data.length).ok
          sendFrame(state, FrameKind.Data, streamId, encodeWsMessage(data, isText))
          if (fits) {
            sendOutputAck(stream, data.length + stream.pendingSelfAck)
            stream.pendingSelfAck = 0
          } else {
            stream.pendingSelfAck += data.length
          }
        },
        onClose: () => {
          if (stream.closed) return
          sendFrame(state, FrameKind.End, streamId, new Uint8Array())
          removeStream(key, 'close')
        },
        onError: () => {
          if (stream.closed) return
          sendReset(state, streamId, ResetCode.InternalError)
          removeStream(key)
        },
      }
    )
  }

  const onDataFrame = (state: DeviceState, streamId: number, plaintext: Uint8Array) => {
    const stream = streams.get(streamKey(state.session.deviceId, streamId))
    if (!stream || stream.closed) return
    if (!stream.machine.onRecv(FrameKind.Data).ok) {
      sendReset(state, streamId, ResetCode.ProtocolError)
      removeStream(streamKey(state.session.deviceId, streamId))
      return
    }
    const ack = stream.recvFlow.onConsume(plaintext.length)
    if (ack) {
      const payload = new Uint8Array(4)
      new DataView(payload.buffer).setUint32(0, ack.ackCumulative)
      sendFrame(state, FrameKind.Ack, streamId, payload)
    }
    try {
      if (stream.transport === 'http') {
        const data = decodeHttpData(plaintext)
        if (data.kind === 'body') stream.http?.onData(data.data)
      } else {
        const message = decodeWsMessage(plaintext)
        ctx.audit.enqueue({
          action: 'ws_input',
          result: 'ok',
          endpoint: stream.path,
          deviceId: state.session.deviceId,
          byteCount: message.data.length,
          preview: message.isText ? textDecoder.decode(message.data) : null,
        })
        stream.ws?.onData(message.data, message.isText)
      }
    } catch {
      sendReset(state, streamId, ResetCode.ProtocolError)
      removeStream(streamKey(state.session.deviceId, streamId))
    }
  }

  const onEndFrame = (state: DeviceState, streamId: number) => {
    const key = streamKey(state.session.deviceId, streamId)
    const stream = streams.get(key)
    if (!stream || stream.closed) return
    stream.machine.onRecv(FrameKind.End)
    if (stream.transport === 'http') stream.http?.onEnd()
    else stream.ws?.onClose()
  }

  const onAckFrame = (state: DeviceState, streamId: number, plaintext: Uint8Array) => {
    const stream = streams.get(streamKey(state.session.deviceId, streamId))
    if (!stream || plaintext.length < 4) return
    const cumulative = new DataView(
      plaintext.buffer,
      plaintext.byteOffset,
      plaintext.byteLength
    ).getUint32(0)
    const resumed = stream.sendFlow.applyAck(cumulative).resumed
    if (resumed && stream.pendingSelfAck > 0) {
      sendOutputAck(stream, stream.pendingSelfAck)
      stream.pendingSelfAck = 0
    }
  }

  const handleOpened = (
    state: DeviceState,
    streamId: number,
    kind: number,
    plaintext: Uint8Array
  ) => {
    if (streamId === CHANNEL_STREAM_ID) return
    if (kind === FrameKind.Open) onOpenFrame(state, streamId, plaintext)
    else if (kind === FrameKind.Data) onDataFrame(state, streamId, plaintext)
    else if (kind === FrameKind.End) onEndFrame(state, streamId)
    else if (kind === FrameKind.Reset) removeStream(streamKey(state.session.deviceId, streamId))
    else if (kind === FrameKind.Ack) onAckFrame(state, streamId, plaintext)
  }

  return {
    attachSocket(sink) {
      send = sink
      daemonConnSalt = generateSalt()
      pendingPhoneSalts.length = 0
      devices.clear()
      retiredPhoneSalts.clear()
      streamOwners.clear()
      for (const key of [...streams.keys()]) removeStream(key)
      emitDaemonSalt()
    },
    onInbound(frame) {
      const bytes = frame instanceof ArrayBuffer ? new Uint8Array(frame) : frame
      if (bytes.length < HEADER_BYTES) {
        ctx.audit.enqueue({ action: 'reject', result: 'rejected', rejectReason: 'short frame' })
        return
      }
      const headerBytes = bytes.subarray(0, HEADER_BYTES)
      const ciphertext = bytes.subarray(HEADER_BYTES)
      let header: FrameHeader
      try {
        header = decodeHeader(headerBytes)
      } catch {
        ctx.audit.enqueue({ action: 'reject', result: 'rejected', rejectReason: 'bad_header' })
        return
      }
      if (header.streamId === CONN_SALT_STREAM_ID) {
        if (!isConnSaltPayload(ciphertext)) return
        try {
          const message = decodeConnSalt(ciphertext)
          if (message.role === 'device') {
            rememberPhoneSalt(message.salt)
            emitDaemonSalt()
          }
        } catch {
          ctx.audit.enqueue({ action: 'reject', result: 'rejected', rejectReason: 'bad_header' })
        }
        return
      }
      const opened = resolveAndOpen(header.streamId, header.seq, headerBytes, ciphertext)
      if (!opened) {
        ctx.audit.enqueue({
          action: 'reject',
          result: 'rejected',
          rejectReason: ctx.deviceSessions.candidates().length > 0 ? 'open_failed' : 'no_session',
        })
        return
      }
      handleOpened(opened.state, header.streamId, header.kind, opened.plaintext)
    },
    resetAllStreams(reason, options) {
      for (const [key, stream] of streams) {
        const state = devices.get(stream.deviceId)
        if (state && send) {
          try {
            sendReset(state, streamIdFromKey(key), ResetCode.InternalError)
          } catch {
            // The gateway socket may already be gone.
          }
        }
        removeStream(key)
      }
      ctx.audit.enqueue({ action: 'session_close', result: 'ok', rejectReason: reason })
      if (!options?.keepSink) send = null
    },
    closeDevice(deviceId, reason) {
      const state = devices.get(deviceId)
      for (const [key, stream] of streams) {
        if (stream.deviceId !== deviceId) continue
        if (state && send) {
          try {
            sendReset(state, streamIdFromKey(key), ResetCode.InternalError)
          } catch {
            // Ignore a socket that is already closing.
          }
        }
        removeStream(key)
      }
      devices.delete(deviceId)
      ctx.audit.enqueue({ action: 'revoke', deviceId, result: 'ok', rejectReason: reason })
    },
  }
}
