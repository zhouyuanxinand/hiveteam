/**
 * Header policy for requests the daemon creates while bridging an encrypted
 * remote stream to its own 127.0.0.1 HTTP/WS server.
 */
export const HIVE_REMOTE_SECRET_HEADER = 'x-hive-remote-secret'
export const HIVE_REMOTE_DEVICE_HEADER = 'x-hive-remote-device'

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const REQUEST_DROPPED_HEADERS = new Set([
  'host',
  'origin',
  'cookie',
  'content-length',
  HIVE_REMOTE_SECRET_HEADER,
  HIVE_REMOTE_DEVICE_HEADER,
])

export function isTunnelDroppedRequestHeader(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    REQUEST_DROPPED_HEADERS.has(lower) ||
    HOP_BY_HOP_HEADERS.has(lower) ||
    lower.startsWith('x-forwarded-')
  )
}

export function stampLoopbackHeaders(
  headers: Array<[string, string]> | Record<string, string>,
  secret: string,
  deviceId: string
): Record<string, string> {
  const entries = Array.isArray(headers) ? headers : Object.entries(headers)
  const stamped: Record<string, string> = {}
  for (const [name, value] of entries) {
    if (!isTunnelDroppedRequestHeader(name)) stamped[name] = value
  }
  stamped[HIVE_REMOTE_SECRET_HEADER] = secret
  stamped[HIVE_REMOTE_DEVICE_HEADER] = deviceId
  return stamped
}

export function isTunnelStrippedResponseHeader(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    HOP_BY_HOP_HEADERS.has(lower) ||
    lower === 'set-cookie' ||
    lower === 'set-cookie2' ||
    lower.startsWith('x-hive-')
  )
}

export function sanitizeTunnelResponseHeaders(
  headers: Array<[string, string]>
): Array<[string, string]> {
  return headers.filter(([name]) => !isTunnelStrippedResponseHeader(name))
}
