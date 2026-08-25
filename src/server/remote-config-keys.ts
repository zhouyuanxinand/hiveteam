export const REMOTE_GATEWAY_URL_KEY = 'remote_gateway_url'
export const REMOTE_DAEMON_TOKEN_KEY = 'remote_daemon_token'
export const REMOTE_DAEMON_ID_KEY = 'remote_daemon_id'
export const REMOTE_ENABLED_KEY = 'remote_enabled'
export const DEFAULT_GATEWAY_URL = 'https://app.hivehq.dev'

export interface RemoteAppStateReader {
  get(key: string): { value: string | null } | undefined
}

export interface RemoteConfigSource {
  isEnabled(): boolean
  getGatewayUrl(): string | null
  getDaemonToken(): string | null
  getDaemonId(): string | null
}

export const createRemoteConfigSource = (store: RemoteAppStateReader): RemoteConfigSource => ({
  isEnabled: () => store.get(REMOTE_ENABLED_KEY)?.value === 'true',
  getGatewayUrl: () => store.get(REMOTE_GATEWAY_URL_KEY)?.value ?? null,
  getDaemonToken: () => store.get(REMOTE_DAEMON_TOKEN_KEY)?.value ?? null,
  getDaemonId: () => store.get(REMOTE_DAEMON_ID_KEY)?.value ?? null,
})
