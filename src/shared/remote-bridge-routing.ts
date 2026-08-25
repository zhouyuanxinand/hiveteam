import { type StreamMeta, StreamTransport } from './remote-protocol.js'

export const ALLOWED_HTTP_PREFIX = '/api/' as const

export type BridgeRejectReason =
  | 'path_not_whitelisted'
  | 'path_not_canonical'
  | 'path_denied'
  | 'bad_method'
  | 'malformed_meta'

export type RouteDecision =
  | { ok: true; transport: 'http'; method: string; path: string }
  | { ok: true; transport: 'ws'; path: string; query?: [string, string][] }
  | { ok: false; reason: BridgeRejectReason }

const terminalPath = /^\/ws\/terminal\/[^/]+\/(?:io|control)$/
const tasksPath = /^\/ws\/tasks\/[^/]+$/
const allowedMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
const deniedHttpPaths = new Set(['/api/ui/session'])

const isDeniedPairingPath = (path: string) =>
  path === '/api/remote/pairings' ||
  path === '/api/remote/pairings/pending' ||
  (path.startsWith('/api/remote/pairings/') &&
    (path.endsWith('/confirm') || path.endsWith('/reject')))

export function isCanonicalPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path[0] !== '/') return false
  if (path.includes('\0') || path.includes('\\') || /%2e|%2f/i.test(path)) return false
  if (path.includes('..') || path.startsWith('//')) return false
  try {
    const parsed = new URL(path, 'http://hive.local')
    return parsed.host === 'hive.local' && parsed.pathname + parsed.search === path
  } catch {
    return false
  }
}

const hasControlChar = (value: string) => {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 0x1f) return true
  }
  return false
}

export function classifyOpen(meta: StreamMeta): RouteDecision {
  if (meta.transport === StreamTransport.Http) {
    const http = meta.http
    if (!http) return { ok: false, reason: 'malformed_meta' }
    if (!isCanonicalPath(http.path)) return { ok: false, reason: 'path_not_canonical' }
    const queryStart = http.path.indexOf('?')
    const pathname = queryStart === -1 ? http.path : http.path.slice(0, queryStart)
    const lowered = pathname.toLowerCase()
    if (deniedHttpPaths.has(lowered) || isDeniedPairingPath(lowered)) {
      return { ok: false, reason: 'path_denied' }
    }
    if (!pathname.startsWith(ALLOWED_HTTP_PREFIX)) {
      return { ok: false, reason: 'path_not_whitelisted' }
    }
    if (!allowedMethods.has(http.method)) return { ok: false, reason: 'bad_method' }
    return { ok: true, transport: 'http', method: http.method, path: http.path }
  }

  if (meta.transport === StreamTransport.Ws) {
    const ws = meta.ws
    if (!ws) return { ok: false, reason: 'malformed_meta' }
    if (!isCanonicalPath(ws.path) || ws.path.includes('?')) {
      return { ok: false, reason: 'path_not_canonical' }
    }
    if (!terminalPath.test(ws.path) && !tasksPath.test(ws.path)) {
      return { ok: false, reason: 'path_not_whitelisted' }
    }
    if (
      ws.query?.some(
        ([key, value]) => key.length === 0 || hasControlChar(key) || hasControlChar(value)
      )
    ) {
      return { ok: false, reason: 'malformed_meta' }
    }
    return ws.query === undefined
      ? { ok: true, transport: 'ws', path: ws.path }
      : { ok: true, transport: 'ws', path: ws.path, query: ws.query }
  }

  return { ok: false, reason: 'malformed_meta' }
}
