import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { randomBytes } from '@noble/ciphers/utils.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

/** Shared by the desktop daemon and the browser device. Keep this wire version stable. */
export const REMOTE_CRYPTO_VERSION = 2
export const X25519_KEY_LEN = 32
export const SHARED_SECRET_LEN = 32
export const SESSION_KEY_LEN = 32
export const NONCE_LEN = 24
export const AEAD_TAG_LEN = 16
export const PAIRING_SECRET_LEN = 32
export const SESSION_SALT_LEN = 32
export const SAS_DIGITS = 6
export const CONN_SALT_LEN = 32

export type Direction = 'd2p' | 'p2d'

export interface DeviceKeyPair {
  secretKey: Uint8Array
  publicKey: Uint8Array
}

export interface PairingPayload {
  v: number
  gatewayUrl: string
  daemonId: string
  pairingSecret: string
}

export interface HandshakeIds {
  daemonId: string
  deviceId: string
  protocolVersion: number
}

export interface SessionKeys {
  d2p: Uint8Array
  p2d: Uint8Array
  sas: string
  transcriptHash: Uint8Array
}

export interface FrameSealer {
  direction: Direction
  nextSeq: number
}

export interface FrameOpener {
  direction: Direction
  lastSeq: number
}

const HKDF_SALT = 'hive/remote/v1/pair'
const INFO_KEY_D2P = 'hive/remote/v1/key/daemon->device'
const INFO_KEY_P2D = 'hive/remote/v1/key/device->daemon'
const INFO_SAS = 'hive/remote/v1/sas'
const TRANSCRIPT_TAG = 'hive/remote/v1/transcript'
const INFO_CONN_D2P = 'hive/remote/v2/conn/daemon->device'
const INFO_CONN_P2D = 'hive/remote/v2/conn/device->daemon'
const CONN_SALT_PREFIX = 'hive/remote/v2/conn-salt'
const DIR_BYTE_D2P = 0x01
const DIR_BYTE_P2D = 0x02
const HEADER_OFF_STREAM_ID = 4
const HEADER_OFF_SEQ = 8
const HEADER_MIN_LEN = 12

const textEncoder = new TextEncoder()
const utf8 = (value: string) => textEncoder.encode(value)

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const u32be = (value: number) => {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`u32be out of range: ${value}`)
  }
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value)
  return out
}

const u32beRead = (bytes: Uint8Array, offset = 0) => {
  if (bytes.length < offset + 4) throw new RangeError('u32beRead: buffer too short')
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset)
}

const u64be = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`u64be out of range: ${value}`)
  }
  const out = new Uint8Array(8)
  const view = new DataView(out.buffer)
  view.setUint32(0, Math.floor(value / 0x1_0000_0000))
  view.setUint32(4, value >>> 0)
  return out
}

const lengthPrefixed = (bytes: Uint8Array) => {
  if (bytes.length > 0xffff) throw new RangeError('value too long for u16 length prefix')
  const out = new Uint8Array(2 + bytes.length)
  new DataView(out.buffer).setUint16(0, bytes.length)
  out.set(bytes, 2)
  return out
}

const assertLength = (bytes: Uint8Array, length: number, name: string) => {
  if (bytes.length !== length) {
    throw new RangeError(`${name} must be ${length} bytes, got ${bytes.length}`)
  }
}

const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const base64Reverse = (() => {
  const result = new Int16Array(128).fill(-1)
  for (let index = 0; index < base64Alphabet.length; index += 1) {
    result[base64Alphabet.charCodeAt(index)] = index
  }
  return result
})()

const byteAt = (bytes: Uint8Array, index: number) => {
  const byte = bytes[index]
  if (byte === undefined) throw new RangeError(`byte index out of range: ${index}`)
  return byte
}

export function toBase64Url(bytes: Uint8Array): string {
  let output = ''
  let index = 0
  for (; index + 3 <= bytes.length; index += 3) {
    const b0 = byteAt(bytes, index)
    const b1 = byteAt(bytes, index + 1)
    const b2 = byteAt(bytes, index + 2)
    output += base64Alphabet[b0 >> 2]
    output += base64Alphabet[((b0 & 0x03) << 4) | (b1 >> 4)]
    output += base64Alphabet[((b1 & 0x0f) << 2) | (b2 >> 6)]
    output += base64Alphabet[b2 & 0x3f]
  }
  const remaining = bytes.length - index
  if (remaining === 1) {
    const b0 = byteAt(bytes, index)
    output += base64Alphabet[b0 >> 2]
    output += base64Alphabet[(b0 & 0x03) << 4]
  } else if (remaining === 2) {
    const b0 = byteAt(bytes, index)
    const b1 = byteAt(bytes, index + 1)
    output += base64Alphabet[b0 >> 2]
    output += base64Alphabet[((b0 & 0x03) << 4) | (b1 >> 4)]
    output += base64Alphabet[(b1 & 0x0f) << 2]
  }
  return output
}

export function fromBase64Url(value: string): Uint8Array {
  if (value.length % 4 === 1) throw new RangeError('invalid base64url')
  const fullGroups = value.length >> 2
  const remainder = value.length & 3
  const output = new Uint8Array(fullGroups * 3 + (remainder === 0 ? 0 : remainder - 1))
  const read = (character: number) => {
    if (character >= 128) throw new RangeError('invalid base64url')
    const decoded = base64Reverse[character]
    if (decoded === undefined || decoded < 0) throw new RangeError('invalid base64url')
    return decoded
  }
  let inputOffset = 0
  let outputOffset = 0
  for (; inputOffset + 4 <= value.length; inputOffset += 4) {
    const c0 = read(value.charCodeAt(inputOffset))
    const c1 = read(value.charCodeAt(inputOffset + 1))
    const c2 = read(value.charCodeAt(inputOffset + 2))
    const c3 = read(value.charCodeAt(inputOffset + 3))
    output[outputOffset++] = (c0 << 2) | (c1 >> 4)
    output[outputOffset++] = ((c1 & 0x0f) << 4) | (c2 >> 2)
    output[outputOffset++] = ((c2 & 0x03) << 6) | c3
  }
  if (remainder === 2) {
    const c0 = read(value.charCodeAt(inputOffset))
    const c1 = read(value.charCodeAt(inputOffset + 1))
    output[outputOffset] = (c0 << 2) | (c1 >> 4)
  } else if (remainder === 3) {
    const c0 = read(value.charCodeAt(inputOffset))
    const c1 = read(value.charCodeAt(inputOffset + 1))
    const c2 = read(value.charCodeAt(inputOffset + 2))
    output[outputOffset++] = (c0 << 2) | (c1 >> 4)
    output[outputOffset] = ((c1 & 0x0f) << 4) | (c2 >> 2)
  }
  return output
}

export function encodePairingPayload(payload: PairingPayload): string {
  return JSON.stringify(payload)
}

export function decodePairingPayload(value: string): PairingPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new RangeError('invalid pairing payload: not JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new RangeError('invalid pairing payload: not an object')
  }
  const raw = parsed as Record<string, unknown>
  if (raw.v !== REMOTE_CRYPTO_VERSION) {
    throw new RangeError(`unsupported pairing version: ${String(raw.v)}`)
  }
  if (typeof raw.gatewayUrl !== 'string' || raw.gatewayUrl.length === 0) {
    throw new RangeError('invalid pairing payload: gatewayUrl')
  }
  if (typeof raw.daemonId !== 'string' || raw.daemonId.length === 0) {
    throw new RangeError('invalid pairing payload: daemonId')
  }
  if (typeof raw.pairingSecret !== 'string') {
    throw new RangeError('invalid pairing payload: pairingSecret')
  }
  const secret = fromBase64Url(raw.pairingSecret)
  assertLength(secret, PAIRING_SECRET_LEN, 'pairingSecret')
  return {
    v: REMOTE_CRYPTO_VERSION,
    gatewayUrl: raw.gatewayUrl,
    daemonId: raw.daemonId,
    pairingSecret: raw.pairingSecret,
  }
}

export function generateDeviceKeyPair(): DeviceKeyPair {
  const secretKey = x25519.utils.randomSecretKey()
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) }
}

export function serializeDeviceKeyPair(keyPair: DeviceKeyPair) {
  return {
    secretKey: toBase64Url(keyPair.secretKey),
    publicKey: toBase64Url(keyPair.publicKey),
  }
}

export function deserializeDeviceKeyPair(serialized: { secretKey: string; publicKey: string }) {
  const secretKey = fromBase64Url(serialized.secretKey)
  const publicKey = fromBase64Url(serialized.publicKey)
  assertLength(secretKey, X25519_KEY_LEN, 'secretKey')
  assertLength(publicKey, X25519_KEY_LEN, 'publicKey')
  return { secretKey, publicKey }
}

export function generateSessionSalt(): Uint8Array {
  return randomBytes(SESSION_SALT_LEN)
}

const deriveSession = (args: {
  localSecretKey: Uint8Array
  peerPublicKey: Uint8Array
  daemonPublicKey: Uint8Array
  devicePublicKey: Uint8Array
  pairingSecret: Uint8Array
  sessionSalt: Uint8Array
  ids: HandshakeIds
}): SessionKeys => {
  assertLength(args.pairingSecret, PAIRING_SECRET_LEN, 'pairingSecret')
  assertLength(args.sessionSalt, SESSION_SALT_LEN, 'sessionSalt')
  assertLength(args.daemonPublicKey, X25519_KEY_LEN, 'daemonPublicKey')
  assertLength(args.devicePublicKey, X25519_KEY_LEN, 'devicePublicKey')
  const sharedSecret = x25519.getSharedSecret(args.localSecretKey, args.peerPublicKey)
  assertLength(sharedSecret, SHARED_SECRET_LEN, 'sharedSecret')

  const transcript = concat(
    utf8(TRANSCRIPT_TAG),
    Uint8Array.of(0),
    u32be(args.ids.protocolVersion),
    lengthPrefixed(utf8(args.ids.daemonId)),
    lengthPrefixed(utf8(args.ids.deviceId)),
    args.daemonPublicKey,
    args.devicePublicKey,
    args.sessionSalt
  )
  const transcriptHash = sha256(transcript)
  const inputKeyMaterial = concat(args.pairingSecret, sharedSecret)
  const salt = concat(utf8(HKDF_SALT), args.sessionSalt)
  const d2p = hkdf(
    sha256,
    inputKeyMaterial,
    salt,
    concat(utf8(INFO_KEY_D2P), Uint8Array.of(0), transcriptHash),
    SESSION_KEY_LEN
  )
  const p2d = hkdf(
    sha256,
    inputKeyMaterial,
    salt,
    concat(utf8(INFO_KEY_P2D), Uint8Array.of(0), transcriptHash),
    SESSION_KEY_LEN
  )
  return { d2p, p2d, sas: deriveSas(transcriptHash, args.ids), transcriptHash }
}

export function deriveDaemonSession(args: {
  daemonSecretKey: Uint8Array
  devicePublicKey: Uint8Array
  daemonPublicKey: Uint8Array
  pairingSecret: Uint8Array
  sessionSalt: Uint8Array
  ids: HandshakeIds
}): SessionKeys {
  return deriveSession({
    localSecretKey: args.daemonSecretKey,
    peerPublicKey: args.devicePublicKey,
    daemonPublicKey: args.daemonPublicKey,
    devicePublicKey: args.devicePublicKey,
    pairingSecret: args.pairingSecret,
    sessionSalt: args.sessionSalt,
    ids: args.ids,
  })
}

export function deriveDeviceSession(args: {
  deviceSecretKey: Uint8Array
  daemonPublicKey: Uint8Array
  devicePublicKey: Uint8Array
  pairingSecret: Uint8Array
  sessionSalt: Uint8Array
  ids: HandshakeIds
}): SessionKeys {
  return deriveSession({
    localSecretKey: args.deviceSecretKey,
    peerPublicKey: args.daemonPublicKey,
    daemonPublicKey: args.daemonPublicKey,
    devicePublicKey: args.devicePublicKey,
    pairingSecret: args.pairingSecret,
    sessionSalt: args.sessionSalt,
    ids: args.ids,
  })
}

export interface ConnectionKeys {
  d2p: Uint8Array
  p2d: Uint8Array
}

export function generateConnSalt(): Uint8Array {
  return randomBytes(CONN_SALT_LEN)
}

export function deriveConnectionKeys(args: {
  rootD2p: Uint8Array
  rootP2d: Uint8Array
  phoneConnSalt: Uint8Array
  daemonConnSalt: Uint8Array
  ids: HandshakeIds
}): ConnectionKeys {
  assertLength(args.rootD2p, SESSION_KEY_LEN, 'rootD2p')
  assertLength(args.rootP2d, SESSION_KEY_LEN, 'rootP2d')
  assertLength(args.phoneConnSalt, CONN_SALT_LEN, 'phoneConnSalt')
  assertLength(args.daemonConnSalt, CONN_SALT_LEN, 'daemonConnSalt')
  const salt = concat(utf8(CONN_SALT_PREFIX), args.phoneConnSalt, args.daemonConnSalt)
  const context = concat(
    Uint8Array.of(0),
    u32be(args.ids.protocolVersion),
    lengthPrefixed(utf8(args.ids.daemonId)),
    lengthPrefixed(utf8(args.ids.deviceId)),
    args.phoneConnSalt,
    args.daemonConnSalt
  )
  return {
    d2p: hkdf(sha256, args.rootD2p, salt, concat(utf8(INFO_CONN_D2P), context), SESSION_KEY_LEN),
    p2d: hkdf(sha256, args.rootP2d, salt, concat(utf8(INFO_CONN_P2D), context), SESSION_KEY_LEN),
  }
}

export function deriveSas(transcriptHash: Uint8Array, ids: HandshakeIds): string {
  assertLength(transcriptHash, 32, 'transcriptHash')
  const bytes = hkdf(
    sha256,
    transcriptHash,
    utf8(HKDF_SALT),
    concat(utf8(INFO_SAS), Uint8Array.of(0), u32be(ids.protocolVersion)),
    4
  )
  return String(u32beRead(bytes) % 1_000_000).padStart(SAS_DIGITS, '0')
}

export function buildNonce(direction: Direction, streamId: number, seq: number): Uint8Array {
  if (direction !== 'd2p' && direction !== 'p2d') {
    throw new RangeError(`bad direction: ${direction}`)
  }
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 0xffffffff) {
    throw new RangeError(`streamId out of range: ${streamId}`)
  }
  const nonce = new Uint8Array(NONCE_LEN)
  nonce[0] = direction === 'd2p' ? DIR_BYTE_D2P : DIR_BYTE_P2D
  nonce.set(u32be(streamId), 1)
  nonce.set(u64be(seq), 8)
  return nonce
}

const readHeaderValue = (headerBytes: Uint8Array, offset: number) => {
  if (headerBytes.length < HEADER_MIN_LEN) throw new RangeError('headerBytes too short')
  return u32beRead(headerBytes, offset)
}

export function sealFrame(args: {
  key: Uint8Array
  direction: Direction
  headerBytes: Uint8Array
  payload: Uint8Array
}): Uint8Array {
  assertLength(args.key, SESSION_KEY_LEN, 'key')
  const nonce = buildNonce(
    args.direction,
    readHeaderValue(args.headerBytes, HEADER_OFF_STREAM_ID),
    readHeaderValue(args.headerBytes, HEADER_OFF_SEQ)
  )
  return xchacha20poly1305(args.key, nonce, args.headerBytes).encrypt(args.payload)
}

export function openFrame(args: {
  key: Uint8Array
  direction: Direction
  headerBytes: Uint8Array
  ciphertext: Uint8Array
}): Uint8Array {
  assertLength(args.key, SESSION_KEY_LEN, 'key')
  const nonce = buildNonce(
    args.direction,
    readHeaderValue(args.headerBytes, HEADER_OFF_STREAM_ID),
    readHeaderValue(args.headerBytes, HEADER_OFF_SEQ)
  )
  return xchacha20poly1305(args.key, nonce, args.headerBytes).decrypt(args.ciphertext)
}

export function createSealer(direction: Direction): FrameSealer {
  return { direction, nextSeq: 0 }
}

export function createOpener(direction: Direction): FrameOpener {
  return { direction, lastSeq: -1 }
}

export function sealNext(
  sealer: FrameSealer,
  args: { key: Uint8Array; streamId: number; headerBytes: Uint8Array; payload: Uint8Array }
) {
  const headerSeq = readHeaderValue(args.headerBytes, HEADER_OFF_SEQ)
  if (headerSeq !== sealer.nextSeq) {
    throw new RangeError(`header seq ${headerSeq} does not match sealer.nextSeq ${sealer.nextSeq}`)
  }
  const ciphertext = sealFrame({
    key: args.key,
    direction: sealer.direction,
    headerBytes: args.headerBytes,
    payload: args.payload,
  })
  const seq = sealer.nextSeq
  sealer.nextSeq += 1
  return { seq, ciphertext }
}

export function openNext(
  opener: FrameOpener,
  args: {
    key: Uint8Array
    streamId: number
    headerBytes: Uint8Array
    ciphertext: Uint8Array
    seq: number
  }
) {
  if (args.seq !== opener.lastSeq + 1) throw new RangeError('out-of-order or replayed frame')
  if (readHeaderValue(args.headerBytes, HEADER_OFF_SEQ) !== args.seq) {
    throw new RangeError('out-of-order or replayed frame')
  }
  const plaintext = openFrame({
    key: args.key,
    direction: opener.direction,
    headerBytes: args.headerBytes,
    ciphertext: args.ciphertext,
  })
  opener.lastSeq = args.seq
  return plaintext
}
