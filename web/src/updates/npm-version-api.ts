import type { VersionInfoPayload } from '../../../src/server/version-service.js'
import { apiFetch, readErrorMessage } from '../api.js'

export const readLatestNpmVersion = async (signal: AbortSignal): Promise<VersionInfoPayload> => {
  const response = await apiFetch('/api/version/latest', {
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Could not check the latest npm version'))
  }
  return (await response.json()) as VersionInfoPayload
}
