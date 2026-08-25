import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { URL } from 'node:url'

import WebSocket, { WebSocketServer } from 'ws'

import { approvedPage, daemonApprovalPage, gatewayHomePage, shell } from './pages.js'
import { encodeControl, HB_PING, HB_PONG, RelayCloseCode, type RelayRole } from './protocol.js'
import { createGatewayStore, type DaemonRecord, type GatewayStore } from './store.js'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8787
const SESSION_COOKIE = 'hive_gateway_session'

type LivePeer = {
  ws: WebSocket
  daemonId: string
  role: RelayRole
  jti?: string
  deviceId?: string
}

export interface GatewayServerOptions {
  host?: string
  port?: number
  dataDir?: string
  ownerToken?: string
  webDistDir?: string
  store?: GatewayStore
}

export interface GatewayServer {
  host: string
  port: number
  store: GatewayStore
  start(): Promise<{ host: string; port: number }>
  close(): Promise<void>
}

const json = (response: ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body)
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(payload)
}

const html = (response: ServerResponse, status: number, body: string) => {
  response.statusCode = status
  response.setHeader('content-type', 'text/html; charset=utf-8')
  response.end(body)
}

const redirect = (response: ServerResponse, location: string) => {
  response.statusCode = 303
  response.setHeader('location', location)
  response.end()
}

const staticContentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

const isStaticAssetPath = (pathname: string) =>
  pathname.startsWith('/assets/') ||
  pathname.startsWith('/cli-icons/') ||
  pathname.startsWith('/icons/') ||
  pathname.startsWith('/screenshots/') ||
  pathname.startsWith('/sounds/') ||
  pathname === '/bilibili.ico' ||
  pathname === '/logo.png' ||
  pathname === '/manifest.webmanifest' ||
  pathname === '/sw.js'

const staticFileFor = (webDistDir: string, pathname: string) => {
  const relativePath =
    pathname === '/app' || pathname === '/app/' ? 'remote.html' : pathname.slice(1)
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(relativePath)
  } catch {
    return null
  }
  if (!decodedPath || decodedPath.includes('\0')) return null
  if (decodedPath.split(/[\\/]/).some((segment) => segment === '..')) return null
  const root = resolve(webDistDir)
  const candidate = resolve(root, decodedPath)
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null
  return candidate
}

const serveStatic = async (response: ServerResponse, webDistDir: string, pathname: string) => {
  if (pathname !== '/app' && pathname !== '/app/' && !isStaticAssetPath(pathname)) return false
  const filename = staticFileFor(webDistDir, pathname)
  if (!filename) return false
  try {
    const file = await stat(filename)
    if (!file.isFile()) return false
    const body = await readFile(filename)
    response.statusCode = 200
    response.setHeader(
      'content-type',
      staticContentTypes[extname(filename).toLowerCase()] ?? 'application/octet-stream'
    )
    response.setHeader(
      'cache-control',
      pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
    )
    response.end(body)
    return true
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
}

const readBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    if (chunks.reduce((total, item) => total + item.length, 0) > 64 * 1024) {
      throw new Error('request body too large')
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

const readPayload = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const body = await readBody(request)
  if (!body) return {}
  const contentType = String(request.headers['content-type'] ?? '').toLowerCase()
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(body).entries())
  }
  try {
    const parsed = JSON.parse(body) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const parseCookies = (header: string | undefined) => {
  const cookies = new Map<string, string>()
  for (const item of (header ?? '').split(';')) {
    const separator = item.indexOf('=')
    if (separator < 0) continue
    cookies.set(
      item.slice(0, separator).trim(),
      decodeURIComponent(item.slice(separator + 1).trim())
    )
  }
  return cookies
}

const bearerToken = (request: IncomingMessage) => {
  const authorization = request.headers.authorization
  if (authorization?.startsWith('Bearer '))
    return authorization.slice('Bearer '.length).trim() || null
  const protocol = String(request.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((value) => value.trim())
    .find((value) => value.startsWith('bearer.'))
  return protocol?.slice('bearer.'.length) || null
}

const daemonFromRequest = (request: IncomingMessage, store: GatewayStore) => {
  const token = bearerToken(request)
  return token ? store.authenticateDaemon(token) : null
}

const sessionFromRequest = (request: IncomingMessage, store: GatewayStore) => {
  const sessionId = parseCookies(request.headers.cookie).get(SESSION_COOKIE)
  return sessionId && store.hasSession(sessionId) ? sessionId : null
}

const machineView = (daemon: DaemonRecord, online: boolean) => ({
  id: daemon.id,
  name: daemon.name ?? 'Hive machine',
  online,
})

export const createGatewayServer = (options: GatewayServerOptions = {}): GatewayServer => {
  const host = options.host ?? process.env.HIVE_GATEWAY_HOST ?? DEFAULT_HOST
  const requestedPort = options.port ?? Number(process.env.HIVE_GATEWAY_PORT ?? DEFAULT_PORT)
  const dataDir = options.dataDir ?? process.env.HIVE_GATEWAY_DATA_DIR ?? '.hive-gateway'
  const webDistDir =
    options.webDistDir ?? process.env.HIVE_WEB_DIST_DIR ?? resolve(process.cwd(), 'web/dist')
  const configuredOwnerToken = options.ownerToken ?? process.env.HIVE_GATEWAY_OWNER_TOKEN
  const store =
    options.store ??
    createGatewayStore({
      dataDir,
      ...(configuredOwnerToken ? { ownerToken: configuredOwnerToken } : {}),
    })
  const server = createServer((request, response) => {
    void handleHttp(request, response).catch((error: unknown) => {
      json(response, 500, { error: error instanceof Error ? error.message : 'internal error' })
    })
  })
  const websocketServer = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    maxPayload: 4 * 1024 * 1024,
  })
  const daemonPeers = new Map<string, LivePeer>()
  const pairPeers = new Map<string, LivePeer>()
  const devicePeers = new Map<string, LivePeer>()
  let activePort = requestedPort

  const sendTo = (peer: LivePeer | undefined, data: string | Buffer) => {
    if (peer?.ws.readyState === WebSocket.OPEN) peer.ws.send(data)
  }

  const sendControl = (
    peer: LivePeer | undefined,
    message: Parameters<typeof encodeControl>[0]
  ) => {
    sendTo(peer, encodeControl(message))
  }

  const closePeer = (peer: LivePeer | undefined, code: number, reason: string) => {
    if (!peer || peer.ws.readyState === WebSocket.CLOSED) return
    try {
      peer.ws.close(code, reason)
    } catch {
      peer.ws.terminate()
    }
  }

  const cleanupPeer = (peer: LivePeer) => {
    if (peer.role === 'daemon') {
      if (daemonPeers.get(peer.daemonId) === peer) daemonPeers.delete(peer.daemonId)
      const device = devicePeers.get(peer.daemonId)
      if (device) {
        devicePeers.delete(peer.daemonId)
        closePeer(device, RelayCloseCode.DaemonOffline, 'daemon offline')
      }
      const pair = pairPeers.get(peer.daemonId)
      if (pair) {
        pairPeers.delete(peer.daemonId)
        closePeer(pair, RelayCloseCode.DaemonOffline, 'daemon offline')
      }
      return
    }
    if (peer.role === 'pair') {
      if (peer.jti && pairPeers.get(peer.daemonId) === peer) pairPeers.delete(peer.daemonId)
      sendControl(daemonPeers.get(peer.daemonId), { t: 'peer-offline', role: 'pair' })
      return
    }
    if (devicePeers.get(peer.daemonId) === peer) devicePeers.delete(peer.daemonId)
    sendControl(daemonPeers.get(peer.daemonId), { t: 'peer-offline', role: 'device' })
  }

  const onPeerMessage = (peer: LivePeer, data: WebSocket.RawData, isBinary: boolean) => {
    const daemon = daemonPeers.get(peer.daemonId)
    if (!daemon || daemon.ws.readyState !== WebSocket.OPEN) return
    if (!isBinary) {
      const text = Buffer.isBuffer(data) ? data.toString() : String(data)
      if (text === HB_PING) {
        sendTo(peer, HB_PONG)
        return
      }
      if (peer.role === 'pair') sendTo(daemon, text)
      return
    }
    if (peer.role === 'device') sendTo(daemon, Buffer.from(data as Buffer))
  }

  const onDaemonMessage = (peer: LivePeer, data: WebSocket.RawData, isBinary: boolean) => {
    if (!isBinary) {
      const text = Buffer.isBuffer(data) ? data.toString() : String(data)
      if (text === HB_PING) {
        sendTo(peer, HB_PONG)
        return
      }
      sendTo(pairPeers.get(peer.daemonId), text)
      return
    }
    sendTo(devicePeers.get(peer.daemonId), Buffer.from(data as Buffer))
  }

  const attachPeer = (peer: LivePeer) => {
    peer.ws.on('message', (data, isBinary) => {
      if (peer.role === 'daemon') onDaemonMessage(peer, data, isBinary)
      else onPeerMessage(peer, data, isBinary)
    })
    peer.ws.on('close', () => cleanupPeer(peer))
    peer.ws.on('error', () => cleanupPeer(peer))
  }

  const acceptWebSocket = (peer: LivePeer) => {
    attachPeer(peer)
    if (peer.role === 'daemon') {
      daemonPeers.set(peer.daemonId, peer)
      sendControl(peer, { t: 'peer-online', role: 'daemon' })
      return
    }
    if (peer.role === 'pair') {
      pairPeers.set(peer.daemonId, peer)
      const control = peer.jti
        ? { t: 'peer-online' as const, role: 'pair' as const, jti: peer.jti }
        : { t: 'peer-online' as const, role: 'pair' as const }
      sendControl(daemonPeers.get(peer.daemonId), control)
      return
    }
    devicePeers.set(peer.daemonId, peer)
    sendControl(daemonPeers.get(peer.daemonId), { t: 'peer-online', role: 'device' })
  }

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
    const path = url.pathname
    const daemon = path === '/relay/daemon' ? daemonFromRequest(request, store) : null
    const sessionId = sessionFromRequest(request, store)
    const daemonId = url.searchParams.get('daemonId') ?? url.searchParams.get('daemon_id')
    const targetDaemon = daemonId ? store.getDaemon(daemonId) : null
    let peer: LivePeer | null = null

    if (daemon) peer = { ws: null as never, daemonId: daemon.id, role: 'daemon' }
    else if (
      sessionId &&
      targetDaemon &&
      daemonPeers.has(targetDaemon.id) &&
      path === '/relay/pair'
    ) {
      peer = { ws: null as never, daemonId: targetDaemon.id, role: 'pair', jti: randomUUID() }
    } else if (
      sessionId &&
      targetDaemon &&
      daemonPeers.has(targetDaemon.id) &&
      path === '/relay/device'
    ) {
      const deviceId = url.searchParams.get('deviceId') ?? url.searchParams.get('device_id')
      const device = deviceId ? store.getDevice(deviceId) : null
      if (deviceId && device?.daemonId === targetDaemon.id) {
        peer = { ws: null as never, daemonId: targetDaemon.id, role: 'device', deviceId }
      }
    }

    if (!peer) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    const current =
      peer.role === 'daemon'
        ? daemonPeers.get(peer.daemonId)
        : peer.role === 'pair'
          ? pairPeers.get(peer.daemonId)
          : devicePeers.get(peer.daemonId)
    if (current) closePeer(current, RelayCloseCode.Replaced, 'replaced by a newer connection')

    const acceptedPeer = peer
    websocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      acceptedPeer.ws = webSocket
      acceptWebSocket(acceptedPeer)
    })
  })

  const requireSession = (request: IncomingMessage, response: ServerResponse) => {
    const sessionId = sessionFromRequest(request, store)
    if (!sessionId) {
      json(response, 401, { error: 'login required' })
      return null
    }
    return sessionId
  }

  const handleHttp = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
    if (request.method === 'OPTIONS') {
      response.statusCode = 204
      response.setHeader('access-control-allow-origin', '*')
      response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
      response.setHeader('access-control-allow-headers', 'content-type,authorization')
      response.end()
      return
    }
    if (request.method === 'GET' && (await serveStatic(response, webDistDir, url.pathname))) {
      return
    }
    if (request.method === 'GET' && url.pathname === '/') {
      html(response, 200, gatewayHomePage())
      return
    }
    if (request.method === 'GET' && url.pathname === '/daemon/approve') {
      const code = url.searchParams.get('code')
      if (!code) {
        html(response, 400, daemonApprovalPage('missing code'))
        return
      }
      html(response, 200, daemonApprovalPage(code))
      return
    }
    if (request.method === 'POST' && url.pathname === '/daemon/approve') {
      const body = await readPayload(request)
      const approved =
        typeof body.code === 'string' &&
        typeof body.token === 'string' &&
        store.approveDaemonCode(body.code, body.token)
      if (!approved) {
        json(response, 403, { error: 'invalid owner token or expired code' })
        return
      }
      if (String(request.headers['content-type'] ?? '').includes('form')) {
        html(response, 200, approvedPage())
      } else {
        json(response, 200, { approved: true })
      }
      return
    }
    if (request.method === 'POST' && url.pathname === '/daemon/code') {
      json(response, 200, { ...store.issueDaemonCode(), pollIntervalMs: 2000 })
      return
    }
    if (request.method === 'POST' && url.pathname === '/daemon/token') {
      const body = await readPayload(request)
      const result =
        typeof body.code === 'string'
          ? store.exchangeDaemonToken(
              body.code,
              typeof body.name === 'string' ? body.name : undefined
            )
          : null
      if (!result) {
        json(response, 401, { error: 'approval pending or code expired' })
        return
      }
      json(response, 200, { daemonId: result.daemonId, daemonToken: result.daemonToken })
      return
    }
    if (request.method === 'POST' && url.pathname === '/auth/login') {
      const body = await readPayload(request)
      if (typeof body.token !== 'string' || body.token !== store.ownerToken()) {
        json(response, 401, { error: 'invalid owner token' })
        return
      }
      const sessionId = store.createSession()
      response.setHeader(
        'set-cookie',
        `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/`
      )
      if (String(request.headers['content-type'] ?? '').includes('form'))
        redirect(response, '/machines')
      else json(response, 200, { ok: true })
      return
    }
    if (request.method === 'GET' && url.pathname === '/machines') {
      if (!requireSession(request, response)) return
      const machines = store
        .listDaemons()
        .map((daemon) => machineView(daemon, daemonPeers.has(daemon.id)))
      html(response, 200, shellMachinesPage(machines))
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/me') {
      if (!requireSession(request, response)) return
      json(response, 200, { ok: true })
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/machines') {
      if (!requireSession(request, response)) return
      json(response, 200, {
        machines: store
          .listDaemons()
          .map((daemon) => machineView(daemon, daemonPeers.has(daemon.id))),
      })
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/devices') {
      if (!requireSession(request, response)) return
      json(response, 200, {
        devices: store.listDevices(url.searchParams.get('daemonId') ?? undefined),
      })
      return
    }
    if (
      request.method === 'POST' &&
      url.pathname.startsWith('/api/devices/') &&
      url.pathname.endsWith('/revoke')
    ) {
      if (!requireSession(request, response)) return
      const id = url.pathname.slice('/api/devices/'.length, -'/revoke'.length)
      if (!store.revokeDevice(id)) {
        json(response, 404, { error: 'device not found' })
        return
      }
      const peer = [...devicePeers.values()].find((candidate) => candidate.deviceId === id)
      if (peer) closePeer(peer, RelayCloseCode.Revoked, 'device revoked')
      json(response, 200, { ok: true })
      return
    }
    if (request.method === 'POST' && url.pathname === '/pair/confirm') {
      const daemon = daemonFromRequest(request, store)
      if (!daemon) {
        json(response, 401, { error: 'daemon authentication required' })
        return
      }
      const body = await readPayload(request)
      const deviceId = typeof body.deviceId === 'string' ? body.deviceId : ''
      const devicePubkey = typeof body.devicePubkey === 'string' ? body.devicePubkey : ''
      const name = typeof body.name === 'string' ? body.name : 'Hive device'
      const boundJti = typeof body.boundJti === 'string' ? body.boundJti : ''
      const pair = boundJti ? pairPeers.get(daemon.id) : undefined
      if (
        !deviceId ||
        !devicePubkey ||
        !pair ||
        pair.jti !== boundJti ||
        pair.daemonId !== daemon.id
      ) {
        json(response, 403, { error: 'pairing session is not active' })
        return
      }
      const device = store.upsertDevice({ daemonId: daemon.id, id: deviceId, name, devicePubkey })
      if (!device) {
        json(response, 404, { error: 'daemon not found' })
        return
      }
      sendTo(pair, JSON.stringify({ t: 'confirmed', deviceId }))
      json(response, 200, { device })
      return
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      json(response, 200, { ok: true, service: 'hive-gateway', daemons: daemonPeers.size })
      return
    }
    json(response, 404, { error: 'not found' })
  }

  const shellMachinesPage = (machines: Array<{ id: string; name: string; online: boolean }>) =>
    shell(
      'Hive machines',
      `<h1>Hive machines</h1>${machines.length === 0 ? '<p>还没有已登录的 Hive 设备。</p>' : machines.map((machine) => `<p><strong>${machine.name}</strong><br><span class="${machine.online ? 'ok' : 'warn'}">${machine.online ? '在线' : '离线'}</span><br><span class="hint">${machine.id}</span>${machine.online ? `<br><a href="/app?daemonId=${encodeURIComponent(machine.id)}">打开 Hive 控制台 →</a>` : ''}</p>`).join('')}`
    )

  return {
    host,
    get port() {
      return activePort
    },
    store,
    async start() {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          const address = server.address()
          activePort = typeof address === 'object' && address ? address.port : requestedPort
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(requestedPort, host)
      })
      return { host, port: activePort }
    },
    async close() {
      for (const peer of [
        ...daemonPeers.values(),
        ...pairPeers.values(),
        ...devicePeers.values(),
      ]) {
        if (peer.ws.readyState !== WebSocket.CLOSED) peer.ws.terminate()
      }
      daemonPeers.clear()
      pairPeers.clear()
      devicePeers.clear()
      websocketServer.close()
      await new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve()
          return
        }
        server.close((error) => (error ? reject(error) : resolve()))
      })
      store.close()
    },
  }
}
