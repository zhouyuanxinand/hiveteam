import {
  fromBase64Url,
  SESSION_SALT_LEN,
  toBase64Url,
  X25519_KEY_LEN,
} from '../shared/remote-crypto.js'
import type { PairConfirmBody, PostPairConfirmDeps } from './remote-gateway-client.js'
import type { RemotePairing } from './remote-pairing.js'

export interface PairingHelloFrame {
  t: 'hello'
  devicePublicKey: string
  sessionSalt: string
  proposedName?: string
}

export type PairingInboundFrame = PairingHelloFrame

export interface PairAckFrame {
  t: 'pair-ack'
  daemonPublicKey: string
  daemonId: string
  deviceId: string
  protocolVersion: number
}

export interface ConfirmedFrame {
  t: 'confirmed'
  deviceId: string
}

export interface RejectedFrame {
  t: 'rejected'
  reason: 'expired'
}

export type PairingOutboundFrame = PairAckFrame | ConfirmedFrame | RejectedFrame

export interface RemotePairingTunnelDeps {
  pairing: RemotePairing
  send: (frame: PairingOutboundFrame) => void
  postPairConfirm: (deps: PostPairConfirmDeps, body: PairConfirmBody) => Promise<void>
  getGatewayUrl: () => string | null
  getDaemonToken: () => string | null
}

const isHello = (value: unknown): value is PairingHelloFrame => {
  if (typeof value !== 'object' || value === null) return false
  const frame = value as Record<string, unknown>
  return (
    frame.t === 'hello' &&
    typeof frame.devicePublicKey === 'string' &&
    typeof frame.sessionSalt === 'string'
  )
}

export interface RemotePairingTunnel {
  onPeerOnline: (jti?: string) => void
  onPairingFrame: (text: string) => void
  confirm: (
    pairingId: string,
    name?: string
  ) => Promise<ReturnType<RemotePairing['confirmPairing']>>
}

export const createRemotePairingTunnel = (deps: RemotePairingTunnelDeps): RemotePairingTunnel => {
  let active: {
    pairingId: string
    deviceId: string
    devicePublicKey: Uint8Array
    boundJti: string | null
    name: string | null
  } | null = null
  let pendingBoundJti: string | null = null

  const onPeerOnline = (jti?: string) => {
    // A new pair socket replaces the previous phone. Never allow the old
    // handshake to be confirmed after that replacement.
    active = null
    pendingBoundJti = jti ?? null
  }

  const onPairingFrame = (text: string) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    if (!isHello(parsed)) return

    let devicePublicKey: Uint8Array
    let sessionSalt: Uint8Array
    try {
      devicePublicKey = fromBase64Url(parsed.devicePublicKey)
      sessionSalt = fromBase64Url(parsed.sessionSalt)
    } catch {
      return
    }
    if (devicePublicKey.length !== X25519_KEY_LEN || sessionSalt.length !== SESSION_SALT_LEN) {
      return
    }

    const pairingId = deps.pairing.findAwaitingHandshake()
    if (!pairingId) {
      deps.send({ t: 'rejected', reason: 'expired' })
      return
    }
    const pending = deps.pairing.submitDeviceHello({
      pairingId,
      devicePublicKey,
      sessionSalt,
      ...(parsed.proposedName !== undefined ? { proposedName: parsed.proposedName } : {}),
    })
    if (!pending) {
      deps.send({ t: 'rejected', reason: 'expired' })
      return
    }
    const reply = deps.pairing.getHandshakeReply(pairingId)
    if (!reply) {
      deps.send({ t: 'rejected', reason: 'expired' })
      return
    }

    active = {
      pairingId,
      deviceId: reply.deviceId,
      devicePublicKey,
      boundJti: pendingBoundJti,
      name: parsed.proposedName ?? null,
    }
    deps.send({
      t: 'pair-ack',
      daemonPublicKey: toBase64Url(reply.daemonPublicKey),
      daemonId: reply.daemonId,
      deviceId: reply.deviceId,
      protocolVersion: reply.protocolVersion,
    })
  }

  const confirm = async (pairingId: string, name?: string) => {
    if (!deps.pairing.getPending(pairingId)) return null
    if (active?.pairingId !== pairingId || !active.boundJti) {
      throw new Error('pairing confirm: missing boundJti for gateway registration')
    }
    const gatewayUrl = deps.getGatewayUrl()
    const daemonToken = deps.getDaemonToken()
    if (!gatewayUrl || !daemonToken) throw new Error('pairing confirm: remote not logged in')

    const deviceName = name ?? active.name ?? 'New device'
    await deps.postPairConfirm(
      { gatewayUrl, daemonToken },
      {
        deviceId: active.deviceId,
        devicePubkey: toBase64Url(active.devicePublicKey),
        name: deviceName,
        boundJti: active.boundJti,
      }
    )
    const record = deps.pairing.confirmPairing(pairingId, name === undefined ? undefined : { name })
    if (!record) return null
    deps.send({ t: 'confirmed', deviceId: record.id })
    active = null
    pendingBoundJti = null
    return record
  }

  return { onPeerOnline, onPairingFrame, confirm }
}
