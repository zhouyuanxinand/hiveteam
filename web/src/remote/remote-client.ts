import {
  createOpener,
  createSealer,
  decodePairingPayload,
  deriveConnectionKeys,
  deriveDeviceSession,
  deserializeDeviceKeyPair,
  fromBase64Url,
  generateConnSalt,
  generateDeviceKeyPair,
  generateSessionSalt,
  openNext,
  type PairingPayload,
  type SessionKeys,
  sealNext,
  serializeDeviceKeyPair,
  toBase64Url,
} from '../../../src/shared/remote-crypto.js'
import {
  CONN_SALT_STREAM_ID,
  createFlowController,
  createStreamIdAllocator,
  decodeAckPayload,
  decodeConnSalt,
  decodeHeader,
  decodeHttpData,
  decodeResetPayload,
  decodeWsMessage,
  encodeAckPayload,
  encodeConnSalt,
  encodeHeader,
  encodeHttpBodyChunk,
  encodeOpenPayload,
  encodeWsMessage,
  FrameKind,
  HEADER_BYTES,
  StreamTransport,
} from '../../../src/shared/remote-protocol.js'

const STORAGE_KEY = 'hive.remote.device.v1'
const MAX_BODY_CHUNK = 48 * 1024
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()
const NativeWebSocket = globalThis.WebSocket

type StoredDevice = {
  pairing: PairingPayload
  deviceId: string
  keyPair: { secretKey: string; publicKey: string }
  rootD2p: string
  rootP2d: string
}

export type PairingProgress =
  | { stage: 'connecting' }
  | { stage: 'awaiting-confirmation'; sas: string }
  | { stage: 'confirmed'; deviceId: string }

type HttpStream = {
  kind: 'http'
  status: number | null
  headers: [string, string][]
  chunks: Uint8Array[]
  resolve: (response: Response) => void
  reject: (error: Error) => void
  recvFlow: ReturnType<typeof createFlowController>
  sendFlow: ReturnType<typeof createFlowController>
}

type WsStream = {
  kind: 'ws'
  socket: RemoteWebSocket
  recvFlow: ReturnType<typeof createFlowController>
  sendFlow: ReturnType<typeof createFlowController>
}

type RemoteStream = HttpStream | WsStream

const concatBytes = (...parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

const bytesFromUnknown = (value: unknown): Uint8Array => {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (typeof value === 'string') return textEncoder.encode(value)
  throw new TypeError('unsupported remote payload')
}

const bytesFromWebSocketData = async (value: unknown): Promise<Uint8Array> => {
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer())
  return bytesFromUnknown(value)
}

const websocketUrl = (base: string, path: string) => {
  const url = new URL(path, base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

const sameOrigin = (url: string) =>
  new URL(url, window.location.href).origin === window.location.origin

const parseStoredDevice = (value: string): StoredDevice | null => {
  try {
    const parsed = JSON.parse(value) as Partial<StoredDevice>
    if (
      typeof parsed.deviceId !== 'string' ||
      typeof parsed.rootD2p !== 'string' ||
      typeof parsed.rootP2d !== 'string' ||
      typeof parsed.keyPair !== 'object' ||
      parsed.keyPair === null ||
      typeof parsed.pairing !== 'object' ||
      parsed.pairing === null
    ) {
      return null
    }
    const pairing = decodePairingPayload(JSON.stringify(parsed.pairing))
    const keyPair = parsed.keyPair as { secretKey?: unknown; publicKey?: unknown }
    if (typeof keyPair.secretKey !== 'string' || typeof keyPair.publicKey !== 'string') return null
    fromBase64Url(parsed.rootD2p)
    fromBase64Url(parsed.rootP2d)
    deserializeDeviceKeyPair(keyPair as { secretKey: string; publicKey: string })
    return {
      pairing,
      deviceId: parsed.deviceId,
      keyPair: { secretKey: keyPair.secretKey, publicKey: keyPair.publicKey },
      rootD2p: parsed.rootD2p,
      rootP2d: parsed.rootP2d,
    }
  } catch {
    return null
  }
}

export const parsePairingText = (value: string): PairingPayload => {
  const candidates = [value.trim(), ...value.split(/\r?\n/).map((line) => line.trim())]
  for (const candidate of candidates.reverse()) {
    if (!candidate) continue
    try {
      return decodePairingPayload(candidate)
    } catch {
      // The desktop copy action also includes the human-readable code line.
    }
  }
  throw new Error('配对数据无效，请从桌面 HiveTeam 的“复制配对数据”重新复制。')
}

const remoteError = (message: string) => new Error(`HiveTeam remote: ${message}`)

export class RemoteWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly CONNECTING = RemoteWebSocket.CONNECTING
  readonly OPEN = RemoteWebSocket.OPEN
  readonly CLOSING = RemoteWebSocket.CLOSING
  readonly CLOSED = RemoteWebSocket.CLOSED
  readonly url: string
  readonly protocol = ''
  readonly extensions = ''
  binaryType: BinaryType = 'arraybuffer'
  bufferedAmount = 0
  readyState = RemoteWebSocket.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  private streamId: number | null = null

  constructor(
    private readonly client: RemoteClient,
    url: string | URL,
    protocols?: string | string[]
  ) {
    super()
    this.url = String(url)
    void client.openWebSocket(this, new URL(this.url, window.location.href), protocols)
  }

  send(data: string | ArrayBufferLike | ArrayBufferView | Blob) {
    if (this.readyState !== RemoteWebSocket.OPEN) throw remoteError('WebSocket is not open')
    void bytesFromWebSocketData(data).then((bytes) => {
      if (this.readyState === RemoteWebSocket.OPEN && this.streamId !== null) {
        this.client.sendWebSocketData(this.streamId, bytes, typeof data === 'string')
      }
    })
  }

  close(code = 1000, reason = '') {
    if (this.readyState === RemoteWebSocket.CLOSED || this.readyState === RemoteWebSocket.CLOSING)
      return
    this.readyState = RemoteWebSocket.CLOSING
    if (this.streamId !== null) this.client.closeWebSocket(this.streamId, code, reason)
    else this.remoteClose(code, reason)
  }

  attachStream(streamId: number) {
    this.streamId = streamId
    this.readyState = RemoteWebSocket.OPEN
    this.emitOpen()
  }

  remoteMessage(data: Uint8Array, isText: boolean) {
    const payload = isText ? textDecoder.decode(data) : data.buffer.slice(0)
    const event = new MessageEvent('message', { data: payload })
    this.dispatchEvent(event)
    this.onmessage?.(event)
  }

  remoteError(message: string) {
    const event = new ErrorEvent('error', { message })
    this.dispatchEvent(event)
    this.onerror?.(event)
  }

  remoteClose(code = 1000, reason = '') {
    if (this.readyState === RemoteWebSocket.CLOSED) return
    this.readyState = RemoteWebSocket.CLOSED
    const event = new CloseEvent('close', { code, reason, wasClean: code === 1000 })
    this.dispatchEvent(event)
    this.onclose?.(event)
  }

  private emitOpen() {
    const event = new Event('open')
    this.dispatchEvent(event)
    this.onopen?.(event)
  }
}

export class RemoteClient {
  private stored: StoredDevice | null = null
  private socket: WebSocket | null = null
  private connectionKeys: { d2p: Uint8Array; p2d: Uint8Array } | null = null
  private phoneConnSalt = generateConnSalt()
  private readonly sealer = createSealer('p2d')
  private readonly opener = createOpener('d2p')
  private readonly allocateStreamId = createStreamIdAllocator('device')
  private readonly streams = new Map<number, RemoteStream>()
  private connectPromise: Promise<void> | null = null

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) this.stored = parseStoredDevice(raw)
    } catch {
      // Some private browsing modes deny localStorage. Pairing can still be
      // attempted for the current tab; the next visit will require pairing.
    }
  }

  get hasStoredDevice() {
    return this.stored !== null
  }

  get storedPairing() {
    return this.stored?.pairing ?? null
  }

  clearStoredDevice() {
    this.disconnect()
    this.stored = null
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // Ignore storage cleanup failures in restricted browser contexts.
    }
  }

  async pair(
    pairingText: string,
    proposedName: string,
    onProgress?: (progress: PairingProgress) => void
  ) {
    const pairing = parsePairingText(pairingText)
    if (!sameOrigin(pairing.gatewayUrl)) {
      throw remoteError('请从配对数据中的网关地址打开手机页面后再配对。')
    }
    const keyPair = generateDeviceKeyPair()
    const sessionSalt = generateSessionSalt()
    const socket = new NativeWebSocket(
      websocketUrl(
        pairing.gatewayUrl,
        `/relay/pair?daemonId=${encodeURIComponent(pairing.daemonId)}`
      )
    )
    socket.binaryType = 'arraybuffer'
    onProgress?.({ stage: 'connecting' })

    await new Promise<void>((resolve, reject) => {
      let settled = false
      let session: SessionKeys | null = null
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        if (error) reject(error)
        else resolve()
      }
      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            t: 'hello',
            devicePublicKey: toBase64Url(keyPair.publicKey),
            sessionSalt: toBase64Url(sessionSalt),
            proposedName: proposedName.trim().slice(0, 80) || 'HiveTeam mobile',
          })
        )
      }
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return
        let message: unknown
        try {
          message = JSON.parse(event.data)
        } catch {
          return
        }
        if (!message || typeof message !== 'object') return
        const frame = message as Record<string, unknown>
        if (frame.t === 'rejected') {
          finish(remoteError('桌面端拒绝了配对。'))
          return
        }
        if (frame.t === 'pair-ack') {
          try {
            const daemonId = typeof frame.daemonId === 'string' ? frame.daemonId : ''
            const deviceId = typeof frame.deviceId === 'string' ? frame.deviceId : ''
            const daemonPublicKey =
              typeof frame.daemonPublicKey === 'string'
                ? fromBase64Url(frame.daemonPublicKey)
                : null
            const protocolVersion =
              typeof frame.protocolVersion === 'number' ? frame.protocolVersion : 0
            if (!daemonId || !deviceId || !daemonPublicKey || protocolVersion !== pairing.v) {
              finish(remoteError('桌面端返回的配对握手不完整。'))
              return
            }
            session = deriveDeviceSession({
              deviceSecretKey: keyPair.secretKey,
              daemonPublicKey,
              devicePublicKey: keyPair.publicKey,
              pairingSecret: fromBase64Url(pairing.pairingSecret),
              sessionSalt,
              ids: { daemonId, deviceId, protocolVersion },
            })
            onProgress?.({ stage: 'awaiting-confirmation', sas: session.sas })
          } catch {
            finish(remoteError('无法验证桌面端握手。'))
          }
          return
        }
        if (frame.t === 'confirmed' && session) {
          const deviceId = typeof frame.deviceId === 'string' ? frame.deviceId : ''
          if (!deviceId) {
            finish(remoteError('配对确认缺少设备 ID。'))
            return
          }
          this.stored = {
            pairing,
            deviceId,
            keyPair: serializeDeviceKeyPair(keyPair),
            rootD2p: toBase64Url(session.d2p),
            rootP2d: toBase64Url(session.p2d),
          }
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this.stored))
          } catch {
            finish(remoteError('浏览器无法保存设备凭据，请关闭无痕模式后重试。'))
            return
          }
          onProgress?.({ stage: 'confirmed', deviceId })
          try {
            socket.close()
          } catch {
            // The gateway may have already closed the pairing socket.
          }
          finish()
        }
      }
      socket.onerror = () => finish(remoteError('无法连接配对通道。'))
      socket.onclose = () => {
        if (!settled) finish(remoteError('配对通道已关闭，请确认桌面端是否批准。'))
      }
    })
  }

  async connect() {
    if (!this.stored) throw remoteError('尚未完成设备配对。')
    if (!sameOrigin(this.stored.pairing.gatewayUrl)) {
      throw remoteError('当前页面和设备配对的网关地址不一致。')
    }
    if (this.socket?.readyState === NativeWebSocket.OPEN && this.connectionKeys) return
    if (this.connectPromise) return this.connectPromise
    const stored = this.stored
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new NativeWebSocket(
        websocketUrl(
          stored.pairing.gatewayUrl,
          `/relay/device?daemonId=${encodeURIComponent(stored.pairing.daemonId)}&deviceId=${encodeURIComponent(stored.deviceId)}`
        )
      )
      socket.binaryType = 'arraybuffer'
      let opened = false
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        if (error) reject(error)
        else resolve()
      }
      socket.onopen = () => {
        opened = true
        this.socket = socket
        this.connectionKeys = null
        this.phoneConnSalt = generateConnSalt()
        this.sealer.nextSeq = 0
        this.opener.lastSeq = -1
        const header = encodeHeader({
          version: stored.pairing.v,
          kind: FrameKind.Data,
          flags: 0,
          streamId: CONN_SALT_STREAM_ID,
          seq: 0,
        })
        const salt = encodeConnSalt({ role: 'device', salt: this.phoneConnSalt })
        socket.send(concatBytes(header, salt))
      }
      socket.onmessage = (event) => {
        try {
          this.onRawFrame(bytesFromUnknown(event.data))
          if (this.connectionKeys) finish()
        } catch (error) {
          finish(error instanceof Error ? error : remoteError('远程帧无法解码。'))
          try {
            socket.close()
          } catch {
            // The socket is already gone.
          }
        }
      }
      socket.onerror = () => {
        if (!opened) finish(remoteError('无法连接 HiveTeam 设备通道。'))
        else if (!settled) finish(remoteError('HiveTeam 设备通道连接失败。'))
      }
      socket.onclose = () => {
        if (!opened) finish(remoteError('设备通道被拒绝，请重新配对。'))
        else if (!settled) finish(remoteError('设备通道未完成加密握手。'))
        this.socket = null
        this.connectionKeys = null
        for (const stream of this.streams.values()) {
          if (stream.kind === 'http') stream.reject(remoteError('设备连接已断开。'))
          else stream.socket.remoteClose(1006, '设备连接已断开')
        }
        this.streams.clear()
      }
    }).finally(() => {
      this.connectPromise = null
    })
    return this.connectPromise
  }

  disconnect() {
    this.socket?.close()
    this.socket = null
    this.connectionKeys = null
    this.streams.clear()
  }

  async fetch(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    fallback: typeof window.fetch
  ): Promise<Response> {
    const requestUrl = new URL(
      typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString(),
      window.location.href
    )
    if (!requestUrl.pathname.startsWith('/api/')) return fallback(input, init)
    await this.connect()
    const request =
      input instanceof Request ? new Request(input, init) : new Request(requestUrl, init)
    const body =
      request.method === 'GET' || request.method === 'HEAD'
        ? new Uint8Array()
        : new Uint8Array(await request.arrayBuffer())
    const headers: [string, string][] = []
    request.headers.forEach((value, key) => {
      headers.push([key, value])
    })
    return this.openHttp({
      method: request.method,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      headers,
      body,
    })
  }

  async openWebSocket(socket: RemoteWebSocket, url: URL, protocols?: string | string[]) {
    try {
      await this.connect()
      const streamId = this.allocateStreamId()
      const subprotocol = Array.isArray(protocols) ? protocols[0] : protocols
      const stream: WsStream = {
        kind: 'ws',
        socket,
        recvFlow: createFlowController(),
        sendFlow: createFlowController(),
      }
      this.streams.set(streamId, stream)
      this.sendFrame(
        FrameKind.Open,
        streamId,
        encodeOpenPayload({
          transport: StreamTransport.Ws,
          ws: {
            path: url.pathname,
            ...(url.searchParams.size > 0
              ? { query: [...url.searchParams.entries()] as [string, string][] }
              : {}),
            ...(subprotocol ? { subprotocol } : {}),
          },
        })
      )
      socket.attachStream(streamId)
    } catch (error) {
      socket.remoteError(error instanceof Error ? error.message : 'WebSocket connection failed')
      socket.remoteClose(1006, 'connection failed')
    }
  }

  sendWebSocketData(streamId: number, data: Uint8Array, isText: boolean) {
    const stream = this.streams.get(streamId)
    if (!stream || stream.kind !== 'ws') return
    const payload = encodeWsMessage(data, isText)
    if (!stream.sendFlow.trySend(payload.length).ok) return
    this.sendFrame(FrameKind.Data, streamId, payload)
  }

  closeWebSocket(streamId: number, _code: number, _reason: string) {
    if (!this.streams.has(streamId)) return
    this.sendFrame(FrameKind.End, streamId, new Uint8Array())
  }

  private async openHttp(args: {
    method: string
    path: string
    headers: [string, string][]
    body: Uint8Array
  }) {
    const streamId = this.allocateStreamId()
    return new Promise<Response>((resolve, reject) => {
      const stream: HttpStream = {
        kind: 'http',
        status: null,
        headers: [],
        chunks: [],
        resolve,
        reject,
        recvFlow: createFlowController(),
        sendFlow: createFlowController(),
      }
      this.streams.set(streamId, stream)
      try {
        this.sendFrame(
          FrameKind.Open,
          streamId,
          encodeOpenPayload({
            transport: StreamTransport.Http,
            http: {
              method: args.method,
              path: args.path,
              headers: args.headers,
              hasBody: args.body.length > 0,
            },
          })
        )
        for (let offset = 0; offset < args.body.length; offset += MAX_BODY_CHUNK) {
          const chunk = args.body.slice(offset, offset + MAX_BODY_CHUNK)
          const payload = encodeHttpBodyChunk(chunk)
          if (!stream.sendFlow.trySend(payload.length).ok) throw remoteError('请求体过大。')
          this.sendFrame(FrameKind.Data, streamId, payload)
        }
        this.sendFrame(FrameKind.End, streamId, new Uint8Array())
      } catch (error) {
        this.streams.delete(streamId)
        reject(error instanceof Error ? error : remoteError('请求失败。'))
      }
    })
  }

  private sendFrame(kind: FrameKind, streamId: number, payload: Uint8Array) {
    if (!this.socket || this.socket.readyState !== NativeWebSocket.OPEN || !this.connectionKeys) {
      throw remoteError('设备连接尚未就绪。')
    }
    const header = encodeHeader({
      version: this.stored?.pairing.v ?? 2,
      kind,
      flags: 0,
      streamId,
      seq: this.sealer.nextSeq,
    })
    const { ciphertext } = sealNext(this.sealer, {
      key: this.connectionKeys.p2d,
      streamId,
      headerBytes: header,
      payload,
    })
    this.socket.send(concatBytes(header, ciphertext))
  }

  private onRawFrame(bytes: Uint8Array) {
    if (bytes.length < HEADER_BYTES) return
    const headerBytes = bytes.slice(0, HEADER_BYTES)
    const ciphertext = bytes.slice(HEADER_BYTES)
    const header = decodeHeader(headerBytes)
    if (header.streamId === CONN_SALT_STREAM_ID) {
      const salt = decodeConnSalt(ciphertext)
      if (salt.role !== 'daemon' || !this.stored) return
      this.connectionKeys = deriveConnectionKeys({
        rootD2p: fromBase64Url(this.stored.rootD2p),
        rootP2d: fromBase64Url(this.stored.rootP2d),
        phoneConnSalt: this.phoneConnSalt,
        daemonConnSalt: salt.salt,
        ids: {
          daemonId: this.stored.pairing.daemonId,
          deviceId: this.stored.deviceId,
          protocolVersion: this.stored.pairing.v,
        },
      })
      return
    }
    if (!this.connectionKeys) return
    const plaintext = openNext(this.opener, {
      key: this.connectionKeys.d2p,
      streamId: header.streamId,
      headerBytes,
      ciphertext,
      seq: header.seq,
    })
    const stream = this.streams.get(header.streamId)
    if (!stream) return
    if (header.kind === FrameKind.Data) {
      const ack = stream.recvFlow.onConsume(plaintext.length)
      if (ack) this.sendFrame(FrameKind.Ack, header.streamId, encodeAckPayload(ack.ackCumulative))
      if (stream.kind === 'http') {
        const data = decodeHttpData(plaintext)
        if (data.kind === 'head') {
          stream.status = data.head.status
          stream.headers = data.head.headers
        } else stream.chunks.push(data.data)
      } else {
        const data = decodeWsMessage(plaintext)
        stream.socket.remoteMessage(data.data, data.isText)
      }
      return
    }
    if (header.kind === FrameKind.Ack) {
      stream.sendFlow.applyAck(decodeAckPayload(plaintext))
      return
    }
    if (header.kind === FrameKind.Reset) {
      const reason = `远程流被重置（${decodeResetPayload(plaintext)}）`
      if (stream.kind === 'http') stream.reject(remoteError(reason))
      else {
        stream.socket.remoteError(reason)
        stream.socket.remoteClose(1006, reason)
      }
      this.streams.delete(header.streamId)
      return
    }
    if (header.kind === FrameKind.End) {
      if (stream.kind === 'http') {
        const body = concatBytes(...stream.chunks)
        const response = new Response(body, {
          status: stream.status ?? 502,
          headers: stream.headers,
        })
        stream.resolve(response)
      } else stream.socket.remoteClose(1000, '')
      this.streams.delete(header.streamId)
    }
  }
}

export const installRemoteTransport = (client: RemoteClient) => {
  const fallbackFetch = window.fetch.bind(window)
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    client.fetch(input, init, fallbackFetch)) as typeof window.fetch

  const BoundRemoteWebSocket = class extends RemoteWebSocket {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3

    constructor(url: string | URL, protocols?: string | string[]) {
      super(client, url, protocols)
    }
  }
  window.WebSocket = BoundRemoteWebSocket as unknown as typeof WebSocket
}
