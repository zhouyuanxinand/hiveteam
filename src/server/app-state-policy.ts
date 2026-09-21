import type { AppStateRecord, AppStateValue } from './app-state-store.js'
import { HttpError } from './http-errors.js'

export class AppStatePolicyError extends HttpError {
  constructor(
    readonly code: 'app_state_key_forbidden' | 'app_state_value_invalid',
    statusCode: number,
    message: string
  ) {
    super(statusCode, message)
    this.name = 'AppStatePolicyError'
  }
}

export interface InternalAppStateStore {
  get(key: string): AppStateRecord | undefined
  set(key: string, value: AppStateValue): void
}

export interface PublicAppStateStore {
  get(key: string): AppStateRecord | undefined
  set(key: string, value: unknown): void
}

// This is the complete HTTP preference schema. Remote credentials/configuration
// belong to remote-config-keys; workspace memory switches and scheduling state
// belong to team-memory-feature. Neither owner is exposed by this interface.
export const assertPublicAppStateKey = (key: string) => {
  if (key !== 'active_workspace_id') {
    throw new AppStatePolicyError(
      'app_state_key_forbidden',
      403,
      'This app-state key is not a public preference'
    )
  }
}

const validateActiveWorkspaceId = (value: unknown): AppStateValue => {
  if (value === null) return null
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value
  ) {
    throw new AppStatePolicyError(
      'app_state_value_invalid',
      400,
      'active_workspace_id must be null or a nonempty string of at most 256 characters'
    )
  }
  return value
}

export const createPublicAppStateStore = (
  internal: InternalAppStateStore
): PublicAppStateStore => ({
  get(key) {
    assertPublicAppStateKey(key)
    return internal.get(key)
  },
  set(key, value) {
    assertPublicAppStateKey(key)
    internal.set(key, validateActiveWorkspaceId(value))
  },
})
