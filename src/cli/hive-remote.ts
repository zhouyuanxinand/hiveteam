#!/usr/bin/env node

import { createAppStateStore } from '../server/app-state-store.js'
import { getMachineName } from '../server/machine-name.js'
import {
  DEFAULT_GATEWAY_URL,
  REMOTE_DAEMON_ID_KEY,
  REMOTE_DAEMON_TOKEN_KEY,
  REMOTE_ENABLED_KEY,
  REMOTE_GATEWAY_URL_KEY,
} from '../server/remote-config-keys.js'
import type { RemoteDeviceRecord } from '../server/remote-device-store.js'
import { createRemoteDeviceStore } from '../server/remote-device-store.js'
import { openRuntimeDatabase } from '../server/runtime-database.js'
import { resolveDataDir } from './hive-data-dir.js'

export {
  DEFAULT_GATEWAY_URL,
  REMOTE_DAEMON_ID_KEY,
  REMOTE_DAEMON_TOKEN_KEY,
  REMOTE_ENABLED_KEY,
  REMOTE_GATEWAY_URL_KEY,
}

export const HIVE_REMOTE_USAGE = [
  'Usage:',
  '  hive remote login [--gateway <url>]   Link this machine to your Hive account.',
  '  hive remote status                    Show remote-access connection state.',
  '  hive remote logout                    Forget the gateway token and disable remote.',
  '  hive remote devices                   List paired devices.',
  '  hive remote revoke <deviceId>         Revoke a paired device.',
  '',
  'Remote access is disabled until login succeeds. The gateway only relays encrypted frames.',
  '',
  'Options:',
  `  --gateway <url>   Gateway base URL (default: ${DEFAULT_GATEWAY_URL}).`,
  '  -h, --help        Print this help.',
].join('\n')

export interface RemoteConfigStore {
  get(key: string): { value: string | null } | undefined
  set(key: string, value: string | null): void
}

export interface RemoteDeviceListStore {
  list(includeRevoked?: boolean): RemoteDeviceRecord[]
  revoke(deviceId: string, now?: number): boolean
  revokeAll?(now?: number): number
}

export interface DaemonCodeResponse {
  code: string
  expiresAt: number
  pollIntervalMs: number
}

export interface DaemonTokenResponse {
  daemonId: string
  daemonToken: string
}

export interface GatewayClient {
  requestCode(gatewayUrl: string): Promise<DaemonCodeResponse>
  exchangeToken(
    gatewayUrl: string,
    code: string,
    name?: string
  ): Promise<DaemonTokenResponse | null>
}

const trimSlash = (url: string) => url.replace(/\/+$/, '')

const postJson = async (url: string, body: unknown, token?: string) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

export const defaultGatewayClient: GatewayClient = {
  async requestCode(gatewayUrl) {
    const response = await postJson(`${trimSlash(gatewayUrl)}/daemon/code`, {})
    if (!response.ok) throw new Error(`gateway /daemon/code failed: ${response.status}`)
    const body = (await response.json()) as Partial<DaemonCodeResponse>
    if (typeof body.code !== 'string' || typeof body.expiresAt !== 'number') {
      throw new Error('gateway /daemon/code returned an unexpected response')
    }
    return {
      code: body.code,
      expiresAt: body.expiresAt,
      pollIntervalMs: typeof body.pollIntervalMs === 'number' ? body.pollIntervalMs : 2000,
    }
  },
  async exchangeToken(gatewayUrl, code, name) {
    const payload: { code: string; name?: string } = { code }
    if (name) payload.name = name
    const response = await postJson(`${trimSlash(gatewayUrl)}/daemon/token`, payload)
    if (response.status === 401 || response.status === 429) return null
    if (!response.ok) throw new Error(`gateway /daemon/token failed: ${response.status}`)
    const body = (await response.json()) as Partial<DaemonTokenResponse>
    if (typeof body.daemonId !== 'string' || typeof body.daemonToken !== 'string') {
      throw new Error('gateway /daemon/token returned an unexpected response')
    }
    return { daemonId: body.daemonId, daemonToken: body.daemonToken }
  },
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const gatewayErrorDetail = (cause: unknown) => {
  if (!(cause instanceof Error)) return String(cause)
  const nested = (cause as Error & { cause?: unknown }).cause
  if (nested instanceof Error && nested.message && nested.message !== cause.message) {
    return `${cause.message} (${nested.message})`
  }
  return cause.message
}

const isTransientGatewayError = (cause: unknown) => {
  const detail = gatewayErrorDetail(cause).toLowerCase()
  return (
    detail.includes('fetch failed') ||
    detail.includes('econnreset') ||
    detail.includes('econnrefused') ||
    detail.includes('etimedout') ||
    detail.includes('enotfound') ||
    detail.includes('eai_again') ||
    detail.includes('connect timeout')
  )
}

const readGatewayFlag = (argv: string[]) => {
  const index = argv.indexOf('--gateway')
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) throw new Error('Usage: hive remote login [--gateway <url>]')
  return value
}

const openConfigStore = () => {
  const db = openRuntimeDatabase(resolveDataDir())
  return { store: createAppStateStore(db), close: () => db.close() }
}

const openDeviceStore = () => {
  const db = openRuntimeDatabase(resolveDataDir())
  return { store: createRemoteDeviceStore(db), close: () => db.close() }
}

const readConfig = (store: RemoteConfigStore, key: string) => store.get(key)?.value ?? null

const approveUrl = (gatewayUrl: string, code: string) =>
  `${trimSlash(gatewayUrl)}/daemon/approve?code=${encodeURIComponent(code)}`

const runLogin = async (
  argv: string[],
  store: RemoteConfigStore,
  client: GatewayClient,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  log: (line: string) => void,
  onDaemonIdentityChange?: () => number
) => {
  const gatewayUrl =
    readGatewayFlag(argv) ?? readConfig(store, REMOTE_GATEWAY_URL_KEY) ?? DEFAULT_GATEWAY_URL
  const { code, expiresAt, pollIntervalMs } = await client.requestCode(gatewayUrl)
  log('Open this approval page in a browser where you are logged in to Hive:')
  log(`  ${approveUrl(gatewayUrl, code)}`)
  log(`  Code: ${code}`)
  log('Waiting for approval…')

  let lastNetworkError: string | null = null
  for (;;) {
    let token: DaemonTokenResponse | null
    try {
      token = await client.exchangeToken(gatewayUrl, code, getMachineName() ?? undefined)
      lastNetworkError = null
    } catch (cause) {
      if (!isTransientGatewayError(cause)) throw cause
      const detail = gatewayErrorDetail(cause)
      if (detail !== lastNetworkError) {
        log(`Gateway connection failed (${detail}); retrying until the code expires…`)
        lastNetworkError = detail
      }
      if (now() >= expiresAt) {
        log('The login code expired. Run `hive remote login` again.')
        return 1
      }
      await sleep(Math.max(250, pollIntervalMs))
      continue
    }
    if (token) {
      const previousDaemonId = readConfig(store, REMOTE_DAEMON_ID_KEY)
      const daemonIdentityChanged = previousDaemonId !== null && previousDaemonId !== token.daemonId
      const revokedDeviceCount = daemonIdentityChanged ? (onDaemonIdentityChange?.() ?? 0) : 0
      store.set(REMOTE_GATEWAY_URL_KEY, gatewayUrl)
      store.set(REMOTE_DAEMON_ID_KEY, token.daemonId)
      store.set(REMOTE_DAEMON_TOKEN_KEY, token.daemonToken)
      store.set(REMOTE_ENABLED_KEY, 'true')
      if (revokedDeviceCount > 0) {
        log(
          `The daemon identity changed; ${revokedDeviceCount} paired device(s) were revoked. Pair the phone again from Settings → Remote access.`
        )
      }
      log('This machine is linked. Remote access is now enabled.')
      log('Restart Hive to connect the remote tunnel.')
      return 0
    }
    if (now() >= expiresAt) {
      log('The login code expired. Run `hive remote login` again.')
      return 1
    }
    await sleep(pollIntervalMs)
  }
}

const runStatus = (store: RemoteConfigStore, log: (line: string) => void) => {
  const enabled = readConfig(store, REMOTE_ENABLED_KEY) === 'true'
  const gatewayUrl = readConfig(store, REMOTE_GATEWAY_URL_KEY)
  const daemonId = readConfig(store, REMOTE_DAEMON_ID_KEY)
  const loggedIn = readConfig(store, REMOTE_DAEMON_TOKEN_KEY) !== null
  log(`Remote access: ${enabled ? 'enabled' : 'disabled'}`)
  log(`Logged in: ${loggedIn ? 'yes' : 'no'}`)
  if (gatewayUrl) log(`Gateway: ${gatewayUrl}`)
  if (daemonId) log(`Machine id: ${daemonId}`)
  if (!loggedIn) log('Run `hive remote login` to link this machine.')
  return 0
}

const runLogout = (store: RemoteConfigStore, log: (line: string) => void) => {
  const wasLoggedIn = readConfig(store, REMOTE_DAEMON_TOKEN_KEY) !== null
  store.set(REMOTE_DAEMON_TOKEN_KEY, null)
  store.set(REMOTE_DAEMON_ID_KEY, null)
  store.set(REMOTE_ENABLED_KEY, 'false')
  log(
    wasLoggedIn
      ? 'Logged out. Remote access is disabled.'
      : 'Not logged in. Remote access is disabled.'
  )
  return 0
}

const runDevices = (store: RemoteDeviceListStore, log: (line: string) => void) => {
  const devices = store.list(true)
  if (devices.length === 0) {
    log('No paired devices. Pair a phone from Settings → Remote access.')
    return 0
  }
  for (const device of devices) {
    const lastSeen = device.lastActive ? new Date(device.lastActive).toISOString() : 'never'
    log(
      `${device.id}  ${device.name}  last active ${lastSeen}${device.revokedAt ? ' (revoked)' : ''}`
    )
  }
  return 0
}

const runRevoke = (
  deviceId: string | undefined,
  store: RemoteDeviceListStore,
  log: (line: string) => void,
  error: (line: string) => void
) => {
  if (!deviceId) {
    error('Usage: hive remote revoke <deviceId>')
    return 1
  }
  if (!store.revoke(deviceId)) {
    error(`Unknown or already-revoked device: ${deviceId}`)
    return 1
  }
  log(`Revoked device ${deviceId}. It is refused on its next connection.`)
  return 0
}

export interface RunHiveRemoteOptions {
  client?: GatewayClient
  config?: RemoteConfigStore
  deviceStore?: RemoteDeviceListStore
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
  error?: (line: string) => void
}

export const runHiveRemoteCommand = async (
  argv: string[],
  options: RunHiveRemoteOptions = {}
): Promise<number> => {
  const log = options.log ?? console.log
  const error = options.error ?? console.error
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    log(HIVE_REMOTE_USAGE)
    return argv.length === 0 ? 1 : 0
  }
  const [subcommand, ...rest] = argv
  const client = options.client ?? defaultGatewayClient
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const closes: Array<() => void> = []
  const resolveConfig = () => {
    if (options.config) return options.config
    const opened = openConfigStore()
    closes.push(opened.close)
    return opened.store
  }
  const resolveDevices = () => {
    if (options.deviceStore) return options.deviceStore
    const opened = openDeviceStore()
    closes.push(opened.close)
    return opened.store
  }
  try {
    switch (subcommand) {
      case 'login':
        return await runLogin(
          rest,
          resolveConfig(),
          client,
          now,
          sleep,
          log,
          () => resolveDevices().revokeAll?.() ?? 0
        )
      case 'status':
        return runStatus(resolveConfig(), log)
      case 'logout':
        return runLogout(resolveConfig(), log)
      case 'devices':
        return runDevices(resolveDevices(), log)
      case 'revoke':
        return runRevoke(rest[0], resolveDevices(), log, error)
      default:
        error(`Unknown remote subcommand: ${subcommand}`)
        error(HIVE_REMOTE_USAGE)
        return 1
    }
  } catch (cause) {
    error(cause instanceof Error ? cause.message : String(cause))
    return 1
  } finally {
    for (const close of closes.reverse()) close()
  }
}
