import type WebSocket from 'ws'
import { WebSocket as NodeWebSocket } from 'ws'
import type { RemoteAuditStore } from './remote-audit-store.js'
import type { RemoteConfigSource } from './remote-config-keys.js'
import {
  GW_CONTROL_PREFIX,
  HB_PING,
  HB_PONG,
  isAuthFatalCloseCode,
} from './remote-control-constants.js'
import type { DeviceSessionProvider } from './remote-device-session.js'
import type { RemoteDeviceRecord } from './remote-device-store.js'
import {
  createFrameBridge,
  type FrameBridge,
  type FrameBridgeContext,
} from './remote-frame-bridge.js'
import { postPairConfirm } from './remote-gateway-client.js'
import type { RemotePairing } from './remote-pairing.js'
import {
  createRemotePairingTunnel,
  type RemotePairingTunnel,
  type RemotePairingTunnelDeps,
} from './remote-pairing-tunnel.js'

export type TunnelStatus =
  | 'disabled'
  | 'loggedOut'
  | 'connecting'
  | 'online'
  | 'reconnecting'
  | 'revoked'

export interface TunnelStatusEvent {
  status: TunnelStatus
  reason?: string
  generation: number
  nextRetryInMs?: number
  gatewayUrl?: string
}

export interface BackoffPolicy {
  next: () => number
  reset: () => void
}

export interface RemoteTunnelDeps {
  loopbackPort: number
  config: RemoteConfigSource
  deviceSessions: DeviceSessionProvider
  loopbackSecret: string
  audit: RemoteAuditStore
  onStatus: (event: TunnelStatusEvent) => void
  pairing?: RemotePairing
  WebSocketImpl?: typeof WebSocket
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout
  clearTimer?: (handle: NodeJS.Timeout) => void
  backoff?: BackoffPolicy
  heartbeatIntervalMs?: number
  heartbeatDeadlineMs?: number
  createBridge?: (context: FrameBridgeContext) => FrameBridge
  createPairingTunnel?: (deps: RemotePairingTunnelDeps) => RemotePairingTunnel
  postPairConfirm?: RemotePairingTunnelDeps['postPairConfirm']
}

export interface RemoteTunnel {
  status: () => TunnelStatus
  refresh: () => void
  revokeAndStop: (reason: string) => void
  closeDevice: (deviceId: string, reason: string) => void
  confirmPairing: (pairingId: string, name?: string) => Promise<RemoteDeviceRecord | null>
  close: () => Promise<void>
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000
const DEFAULT_HEARTBEAT_DEADLINE_MS = 10_000
const CLOSE_GRACE_MS = 1_000

const createDefaultBackoff = (): BackoffPolicy => {
  let attempt = 0
  return {
    next() {
      const max = Math.min(30_000, 500 * 2 ** attempt)
      attempt += 1
      return Math.floor(Math.random() * max)
    },
    reset() {
      attempt = 0
    },
  }
}

export const relayDaemonUrl = (gatewayUrl: string) => {
  const url = new URL(gatewayUrl)
  if (url.protocol === 'https:') url.protocol = 'wss:'
  else if (url.protocol === 'http:') url.protocol = 'ws:'
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
    throw new Error(`unsupported gateway protocol: ${url.protocol}`)
  }
  const loopback =
    url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === '[::1]'
  if (url.protocol === 'ws:' && !loopback) {
    throw new Error('insecure ws:// gateway is only allowed for a numeric loopback host')
  }
  return `${url.toString().replace(/\/+$/, '')}/relay/daemon`
}

const toArrayBuffer = (data: WebSocket.RawData) => {
  const buffer = Array.isArray(data)
    ? Buffer.concat(data)
    : data instanceof ArrayBuffer
      ? Buffer.from(new Uint8Array(data))
      : Buffer.from(data)
  const copy = new ArrayBuffer(buffer.byteLength)
  new Uint8Array(copy).set(buffer)
  return copy
}

export const createRemoteTunnel = (deps: RemoteTunnelDeps): RemoteTunnel => {
  const WebSocketImpl = deps.WebSocketImpl ?? NodeWebSocket
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle))
  const backoff = deps.backoff ?? createDefaultBackoff()
  const heartbeatInterval = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
  const heartbeatDeadline = deps.heartbeatDeadlineMs ?? DEFAULT_HEARTBEAT_DEADLINE_MS

  let generation = 0
  let currentStatus: TunnelStatus = 'disabled'
  let revokedLatch = false
  let closing = false
  let socket: WebSocket | null = null
  let bridge: FrameBridge | null = null
  let reconnectTimer: NodeJS.Timeout | null = null
  let heartbeatTimer: NodeJS.Timeout | null = null
  let heartbeatDeadlineTimer: NodeJS.Timeout | null = null

  const createBridge = deps.createBridge ?? ((context) => createFrameBridge(context))
  const createPairingTunnel = deps.createPairingTunnel ?? createRemotePairingTunnel
  let pairingTunnel: RemotePairingTunnel | null = null

  const emit = (
    status: TunnelStatus,
    currentGeneration: number,
    extra: Omit<TunnelStatusEvent, 'status' | 'generation'> = {}
  ) => {
    currentStatus = status
    deps.onStatus({ status, generation: currentGeneration, ...extra })
  }

  const clearReconnect = () => {
    if (reconnectTimer) {
      clearTimer(reconnectTimer)
      reconnectTimer = null
    }
  }

  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearTimer(heartbeatTimer)
      heartbeatTimer = null
    }
    if (heartbeatDeadlineTimer) {
      clearTimer(heartbeatDeadlineTimer)
      heartbeatDeadlineTimer = null
    }
  }

  const detachSocket = () => {
    if (socket) {
      socket.removeAllListeners()
      socket = null
    }
    bridge = null
  }

  const absorbCloseError = (target: WebSocket) => target.once('error', () => {})
  const wantsConnection = () => deps.config.isEnabled() && deps.config.getDaemonToken() !== null

  const onSocketDown = (code: number, reason: string) => {
    stopHeartbeat()
    bridge?.resetAllStreams(reason)
    deps.audit.enqueue({ action: 'session_close', result: 'ok', rejectReason: reason })
    const oldSocket = socket
    detachSocket()
    if (oldSocket) {
      absorbCloseError(oldSocket)
      try {
        oldSocket.terminate()
      } catch {
        // Socket is already closed.
      }
    }
    generation += 1
    if (closing) return
    if (isAuthFatalCloseCode(code)) {
      revokedLatch = true
      emit('revoked', generation, { reason })
      return
    }
    if (!wantsConnection()) {
      emit(deps.config.isEnabled() ? 'loggedOut' : 'disabled', generation, { reason })
      return
    }
    const delay = backoff.next()
    emit('reconnecting', generation, { reason, nextRetryInMs: delay })
    clearReconnect()
    reconnectTimer = setTimer(() => {
      reconnectTimer = null
      openSocket()
    }, delay)
  }

  const armHeartbeat = (socketGeneration: number) => {
    stopHeartbeat()
    const tick = () => {
      if (socketGeneration !== generation || !socket) return
      try {
        socket.send(HB_PING)
      } catch {
        return
      }
      if (!heartbeatDeadlineTimer) {
        heartbeatDeadlineTimer = setTimer(() => {
          heartbeatDeadlineTimer = null
          if (socketGeneration === generation) onSocketDown(1006, 'heartbeat timeout')
        }, heartbeatDeadline)
      }
      heartbeatTimer = setTimer(tick, heartbeatInterval)
    }
    heartbeatTimer = setTimer(tick, heartbeatInterval)
  }

  const onControl = (raw: string) => {
    let control: unknown
    try {
      control = JSON.parse(raw.slice(GW_CONTROL_PREFIX.length))
    } catch {
      return
    }
    if (typeof control !== 'object' || control === null) return
    const message = control as {
      t?: string
      role?: string
      jti?: string
      reason?: string
      code?: number
      message?: string
    }
    if (message.t === 'revoked') {
      revokeAndStop(message.reason ?? 'gateway revoked the daemon')
    } else if (message.t === 'peer-offline') {
      if (message.role === 'pair') return
      bridge?.resetAllStreams('peer offline', { keepSink: true })
    } else if (message.t === 'peer-online' && message.role === 'pair') {
      pairingTunnel?.onPeerOnline(message.jti)
    } else if (message.t === 'error') {
      onSocketDown(message.code ?? 1006, message.message ?? 'gateway error')
    }
  }

  const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
    if (!isBinary) {
      const text = Buffer.isBuffer(data) ? data.toString() : String(data)
      if (text === HB_PONG) {
        if (heartbeatDeadlineTimer) {
          clearTimer(heartbeatDeadlineTimer)
          heartbeatDeadlineTimer = null
        }
      } else if (text.startsWith(GW_CONTROL_PREFIX)) {
        onControl(text)
      } else {
        pairingTunnel?.onPairingFrame(text)
      }
      return
    }
    bridge?.onInbound(toArrayBuffer(data))
  }

  const openSocket = () => {
    if (closing || revokedLatch) return
    const socketGeneration = ++generation
    if (!deps.config.isEnabled()) {
      emit('disabled', socketGeneration)
      return
    }
    const gatewayUrl = deps.config.getGatewayUrl()
    const token = deps.config.getDaemonToken()
    if (!gatewayUrl || !token) {
      emit('loggedOut', socketGeneration)
      return
    }

    let url: string
    try {
      url = relayDaemonUrl(gatewayUrl)
    } catch (error) {
      emit('reconnecting', socketGeneration, {
        reason: error instanceof Error ? error.message : 'invalid gateway URL',
      })
      return
    }
    emit('connecting', socketGeneration)
    let nextSocket: WebSocket
    try {
      nextSocket = new WebSocketImpl(url, [`bearer.${token}`])
    } catch {
      onSocketDown(1006, 'socket construction failed')
      return
    }
    socket = nextSocket
    nextSocket.binaryType = 'arraybuffer'
    nextSocket.on('open', () => {
      if (socketGeneration !== generation) return
      const daemonId = deps.config.getDaemonId()
      if (!daemonId) {
        onSocketDown(1006, 'missing daemon id')
        return
      }
      bridge = createBridge({
        loopbackPort: deps.loopbackPort,
        loopbackSecret: deps.loopbackSecret,
        deviceSessions: deps.deviceSessions,
        audit: deps.audit,
        daemonId,
      })
      bridge.attachSocket((frame) => {
        try {
          nextSocket.send(frame)
        } catch {
          // close handler will recover the socket
        }
      })
      if (deps.pairing && !pairingTunnel) {
        pairingTunnel = createPairingTunnel({
          pairing: deps.pairing,
          send: (frame) => {
            try {
              socket?.send(JSON.stringify(frame))
            } catch {
              // The socket is closing; the phone will retry pairing.
            }
          },
          postPairConfirm: deps.postPairConfirm ?? postPairConfirm,
          getGatewayUrl: deps.config.getGatewayUrl,
          getDaemonToken: deps.config.getDaemonToken,
        })
      }
      backoff.reset()
      deps.audit.enqueue({ action: 'session_open', result: 'ok' })
      armHeartbeat(socketGeneration)
      emit('online', socketGeneration, { gatewayUrl })
    })
    nextSocket.on('message', (data, isBinary) => {
      if (socketGeneration === generation) onMessage(data, isBinary)
    })
    nextSocket.on('close', (code, reason) => {
      if (socketGeneration === generation) onSocketDown(code, reason.toString() || 'closed')
    })
    nextSocket.on('error', () => {
      if (socketGeneration === generation) onSocketDown(1006, 'socket error')
    })
    nextSocket.on('unexpected-response', (_request, response) => {
      if (socketGeneration === generation)
        onSocketDown(1006, `unexpected response ${response.statusCode ?? '?'}`)
    })
  }

  const teardownSocket = (reason: string) => {
    stopHeartbeat()
    clearReconnect()
    bridge?.resetAllStreams(reason)
    const oldSocket = socket
    detachSocket()
    if (!oldSocket) return
    absorbCloseError(oldSocket)
    try {
      oldSocket.close(1000, reason)
    } catch {
      try {
        oldSocket.terminate()
      } catch {
        // Already gone.
      }
    }
  }

  function revokeAndStop(reason: string) {
    if (revokedLatch && socket === null) return
    revokedLatch = true
    teardownSocket(reason)
    generation += 1
    deps.audit.enqueue({ action: 'session_close', result: 'rejected', rejectReason: 'revoked' })
    emit('revoked', generation, { reason })
  }

  const refresh = () => {
    if (closing) return
    revokedLatch = false
    clearReconnect()
    if (!deps.config.isEnabled()) {
      if (socket) teardownSocket('disabled')
      generation += 1
      emit('disabled', generation)
      return
    }
    if (deps.config.getDaemonToken() === null) {
      if (socket) teardownSocket('logged out')
      generation += 1
      emit('loggedOut', generation)
      return
    }
    if (socket && (currentStatus === 'online' || currentStatus === 'connecting')) return
    openSocket()
  }

  const close = async () => {
    closing = true
    clearReconnect()
    stopHeartbeat()
    const oldSocket = socket
    bridge?.resetAllStreams('shutdown')
    detachSocket()
    generation += 1
    if (!oldSocket) return
    absorbCloseError(oldSocket)
    await new Promise<void>((resolve) => {
      let finished = false
      const done = () => {
        if (finished) return
        finished = true
        resolve()
      }
      const grace = setTimer(() => {
        try {
          oldSocket.terminate()
        } catch {
          // Already gone.
        }
        done()
      }, CLOSE_GRACE_MS)
      oldSocket.once('close', () => {
        clearTimer(grace)
        done()
      })
      try {
        oldSocket.close(1000, 'shutdown')
      } catch {
        clearTimer(grace)
        done()
      }
    })
  }

  return {
    status: () => currentStatus,
    refresh,
    revokeAndStop,
    closeDevice: (deviceId, reason) => bridge?.closeDevice(deviceId, reason),
    confirmPairing: async (pairingId, name) =>
      (await pairingTunnel?.confirm(pairingId, name)) ?? null,
    close,
  }
}
