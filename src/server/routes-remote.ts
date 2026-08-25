import { ForbiddenError } from './http-errors.js'
import type { RemoteDeviceRecord } from './remote-device-store.js'
import { HIVE_REMOTE_DEVICE_HEADER, HIVE_REMOTE_SECRET_HEADER } from './remote-loopback-auth.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const serializeDevice = (device: {
  id: string
  name: string
  createdAt: number
  lastActive: number | null
  revokedAt: number | null
}) => ({
  id: device.id,
  name: device.name,
  created_at: device.createdAt,
  last_active: device.lastActive,
  revoked_at: device.revokedAt,
})

const serializePairingTicket = (ticket: {
  pairingId: string
  qr: string
  code: string
  expiresAt: number
}) => ({
  pairing_id: ticket.pairingId,
  qr: ticket.qr,
  code: ticket.code,
  expires_at: ticket.expiresAt,
})

const serializePendingPairing = (pending: {
  pairingId: string
  deviceName: string | null
  sas: string
  expiresAt: number
}) => ({
  pairing_id: pending.pairingId,
  device_name: pending.deviceName,
  sas: pending.sas,
  expires_at: pending.expiresAt,
})

const parseLimit = (value: string | undefined) => {
  const parsed = value ? Number.parseInt(value, 10) : 100
  return Number.isFinite(parsed) ? parsed : 100
}

const isRemoteTunnelRequest = (
  request: Parameters<RouteDefinition['handler']>[0]['request'],
  store: Parameters<RouteDefinition['handler']>[0]['store']
) => {
  const header = request.headers[HIVE_REMOTE_SECRET_HEADER]
  const secret = Array.isArray(header) ? header[0] : header
  return store.validateRemoteTunnelSecret(secret)
}

const requireDesktopPairingAction = (
  request: Parameters<RouteDefinition['handler']>[0]['request'],
  store: Parameters<RouteDefinition['handler']>[0]['store']
) => {
  if (isRemoteTunnelRequest(request, store)) {
    const deviceHeader = request.headers[HIVE_REMOTE_DEVICE_HEADER]
    const deviceId = Array.isArray(deviceHeader) ? deviceHeader[0] : deviceHeader
    store.remote.audit.enqueue({
      action: 'reject',
      deviceId: deviceId ?? null,
      endpoint: request.url ?? null,
      result: 'rejected',
      rejectReason: 'pairing_confirm_forbidden',
    })
    throw new ForbiddenError('Device approval is desktop-only')
  }
  requireUiTokenFromRequest(request, store.validateUiToken)
}

export const remoteRoutes: RouteDefinition[] = [
  route('GET', '/api/remote/status', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const tunnelStatus = store.remote.tunnel?.status() ?? 'disabled'
    sendJson(response, 200, {
      enabled: store.remote.config.isEnabled(),
      logged_in: store.remote.config.getDaemonToken() !== null,
      gateway_url: store.remote.config.getGatewayUrl(),
      daemon_id: store.remote.config.getDaemonId(),
      status: tunnelStatus,
      connection: tunnelStatus,
      connected: tunnelStatus === 'online',
      devices: store.remote.devices.list(false).length,
    })
  }),
  route('PUT', '/api/remote/enabled', async ({ request, response, store }) => {
    const body = await readJsonBody<{ enabled?: boolean }>(request)
    if (body.enabled === true && isRemoteTunnelRequest(request, store)) {
      throw new ForbiddenError('Remote devices cannot enable remote access')
    }
    requireUiTokenFromRequest(request, store.validateUiToken)
    if (body.enabled === true && !store.remote.config.getDaemonToken()) {
      sendJson(response, 409, { error: 'Run hive remote login before enabling remote access' })
      return
    }
    store.settings.setAppState('remote_enabled', body.enabled === true ? 'true' : 'false')
    store.remote.tunnel?.refresh()
    const status = store.remote.tunnel?.status() ?? 'disabled'
    sendJson(response, 200, {
      enabled: store.remote.config.isEnabled(),
      connected: status === 'online',
      connection: status,
    })
  }),
  route('GET', '/api/remote/devices', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const includeRevoked =
      url.searchParams.has('include_revoked') || url.searchParams.has('includeRevoked')
    sendJson(response, 200, store.remote.devices.list(includeRevoked).map(serializeDevice))
  }),
  route('POST', '/api/remote/pairings', ({ request, response, store }) => {
    requireDesktopPairingAction(request, store)
    if (!store.remote.config.isEnabled() || !store.remote.config.getDaemonToken()) {
      sendJson(response, 409, { error: 'Remote access is not logged in and enabled' })
      return
    }
    sendJson(response, 200, serializePairingTicket(store.remote.pairing.beginPairing()))
  }),
  route('GET', '/api/remote/pairings/pending', ({ request, response, store }) => {
    requireDesktopPairingAction(request, store)
    sendJson(response, 200, store.remote.pairing.listPending().map(serializePendingPairing))
  }),
  route('GET', '/api/remote/pairings/:pairingId', ({ params, request, response, store }) => {
    requireDesktopPairingAction(request, store)
    const pairingId = getRequiredParam(response, params, 'pairingId', 'Pairing id is required')
    if (!pairingId) return
    const pending = store.remote.pairing.getPending(pairingId)
    if (!pending) {
      sendJson(response, 404, { error: 'Pairing is not awaiting desktop confirmation' })
      return
    }
    sendJson(response, 200, serializePendingPairing(pending))
  }),
  route(
    'POST',
    '/api/remote/pairings/:pairingId/confirm',
    async ({ params, request, response, store }) => {
      const pairingId = getRequiredParam(response, params, 'pairingId', 'Pairing id is required')
      if (!pairingId) return
      requireDesktopPairingAction(request, store)
      const body = await readJsonBody<{ name?: string }>(request)
      let device: RemoteDeviceRecord | null
      try {
        device = store.remote.tunnel
          ? await store.remote.tunnel.confirmPairing(pairingId, body.name)
          : store.remote.pairing.confirmPairing(
              pairingId,
              body.name === undefined ? undefined : { name: body.name }
            )
      } catch (error) {
        sendJson(response, 502, {
          error: error instanceof Error ? error.message : 'Remote pairing confirmation failed',
        })
        return
      }
      if (!device) {
        sendJson(response, 409, { error: 'Pairing is no longer awaiting confirmation' })
        return
      }
      sendJson(response, 200, { device: serializeDevice(device) })
    }
  ),
  route(
    'POST',
    '/api/remote/pairings/:pairingId/reject',
    ({ params, request, response, store }) => {
      const pairingId = getRequiredParam(response, params, 'pairingId', 'Pairing id is required')
      if (!pairingId) return
      requireDesktopPairingAction(request, store)
      store.remote.pairing.rejectPairing(pairingId, 'desktop_rejected')
      response.statusCode = 204
      response.end()
    }
  ),
  route('POST', '/api/remote/devices/:deviceId/revoke', ({ params, request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const deviceId = getRequiredParam(response, params, 'deviceId', 'Device id is required')
    if (!deviceId) return
    if (!store.remote.devices.revoke(deviceId)) {
      sendJson(response, 404, { error: 'Remote device not found' })
      return
    }
    store.remote.tunnel?.closeDevice(deviceId, 'device revoked')
    store.remote.audit.enqueue({
      action: 'revoke',
      deviceId,
      result: 'ok',
    })
    response.statusCode = 204
    response.end()
  }),
  route('GET', '/api/remote/audit', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    sendJson(
      response,
      200,
      store.remote.audit.list(parseLimit(url.searchParams.get('limit') ?? undefined))
    )
  }),
  route('GET', '/api/remote/audit/devices/:deviceId', ({ params, request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const deviceId = getRequiredParam(response, params, 'deviceId', 'Device id is required')
    if (!deviceId) return
    sendJson(response, 200, store.remote.audit.listForDevice(deviceId))
  }),
  route('PUT', '/api/remote/config', async ({ request, response, store }) => {
    if (isRemoteTunnelRequest(request, store)) {
      throw new ForbiddenError('Remote devices cannot change remote configuration')
    }
    requireUiTokenFromRequest(request, store.validateUiToken)
    const body = await readJsonBody<{ gateway_url?: string; enabled?: boolean }>(request)
    if (body.gateway_url !== undefined) {
      const gatewayUrl = body.gateway_url.trim()
      if (!gatewayUrl || !/^https?:\/\//i.test(gatewayUrl)) {
        sendJson(response, 400, { error: 'gateway_url must be an http(s) URL' })
        return
      }
      store.settings.setAppState('remote_gateway_url', gatewayUrl)
    }
    if (body.enabled === true && isRemoteTunnelRequest(request, store)) {
      throw new ForbiddenError('Remote devices cannot enable remote access')
    }
    if (body.enabled === true && !store.remote.config.getDaemonToken()) {
      sendJson(response, 409, { error: 'Run hive remote login before enabling remote access' })
      return
    }
    if (body.enabled !== undefined) {
      store.settings.setAppState('remote_enabled', body.enabled ? 'true' : 'false')
    }
    store.remote.tunnel?.refresh()
    sendJson(response, 200, {
      enabled: store.remote.config.isEnabled(),
      gateway_url: store.remote.config.getGatewayUrl(),
      status: store.remote.tunnel?.status() ?? 'disabled',
    })
  }),
]
