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

const parseLimit = (value: string | undefined) => {
  const parsed = value ? Number.parseInt(value, 10) : 100
  return Number.isFinite(parsed) ? parsed : 100
}

export const remoteRoutes: RouteDefinition[] = [
  route('GET', '/api/remote/status', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    sendJson(response, 200, {
      enabled: store.remote.config.isEnabled(),
      gateway_url: store.remote.config.getGatewayUrl(),
      daemon_id: store.remote.config.getDaemonId(),
      connected: false,
      devices: store.remote.devices.list(true).length,
    })
  }),
  route('GET', '/api/remote/devices', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    sendJson(response, 200, store.remote.devices.list(true).map(serializeDevice))
  }),
  route('POST', '/api/remote/pairings', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    if (!store.remote.config.isEnabled()) {
      sendJson(response, 409, { error: 'Remote access is disabled' })
      return
    }
    sendJson(response, 201, store.remote.pairing.beginPairing())
  }),
  route('GET', '/api/remote/pairings/pending', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    sendJson(response, 200, store.remote.pairing.listPending())
  }),
  route('GET', '/api/remote/pairings/:pairingId', ({ params, request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const pairingId = getRequiredParam(response, params, 'pairingId', 'Pairing id is required')
    if (!pairingId) return
    const pending = store.remote.pairing.getPending(pairingId)
    if (!pending) {
      sendJson(response, 404, { error: 'Pairing is not awaiting desktop confirmation' })
      return
    }
    sendJson(response, 200, pending)
  }),
  route(
    'POST',
    '/api/remote/pairings/:pairingId/confirm',
    async ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const pairingId = getRequiredParam(response, params, 'pairingId', 'Pairing id is required')
      if (!pairingId) return
      const body = await readJsonBody<{ name?: string }>(request)
      const device = store.remote.pairing.confirmPairing(
        pairingId,
        body.name === undefined ? undefined : { name: body.name }
      )
      if (!device) {
        sendJson(response, 409, { error: 'Pairing is no longer awaiting confirmation' })
        return
      }
      sendJson(response, 201, serializeDevice(device))
    }
  ),
  route(
    'POST',
    '/api/remote/pairings/:pairingId/reject',
    ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const pairingId = getRequiredParam(response, params, 'pairingId', 'Pairing id is required')
      if (!pairingId) return
      store.remote.pairing.rejectPairing(pairingId, 'desktop_rejected')
      sendJson(response, 200, { ok: true })
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
    store.remote.audit.enqueue({
      action: 'revoke',
      deviceId,
      result: 'ok',
    })
    sendJson(response, 200, { ok: true })
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
    if (body.enabled !== undefined) {
      store.settings.setAppState('remote_enabled', body.enabled ? 'true' : 'false')
    }
    sendJson(response, 200, {
      enabled: store.remote.config.isEnabled(),
      gateway_url: store.remote.config.getGatewayUrl(),
    })
  }),
]
