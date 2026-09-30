import { compareSemverVersions } from '../shared/semver.js'
import { HttpError } from './http-errors.js'
import { PACKAGE_NAME, PROJECT_REPOSITORY_URL, readPackageVersion } from './package-version.js'

export interface VersionInfoPayload {
  current_version: string
  install_hint: string
  latest_version: string
  package_name: string
  release_url: string
  update_available: boolean
}

export interface VersionService {
  getVersionInfo: () => Promise<VersionInfoPayload>
  getLatestVersionInfo: () => Promise<VersionInfoPayload>
}

export interface VersionServiceOptions {
  currentVersion?: string
  fetchImpl?: typeof fetch
  registryUrl?: string
  now?: () => number
  timeoutMs?: number
  cacheTtlMs?: number
}

export class VersionLookupError extends HttpError {
  constructor(message: string, cause?: unknown) {
    super(503, message)
    this.name = 'VersionLookupError'
    this.cause = cause
  }
}

const buildVersionInfo = (currentVersion: string): VersionInfoPayload => ({
  current_version: currentVersion,
  install_hint: `npm install -g ${PACKAGE_NAME}@latest`,
  latest_version: currentVersion,
  package_name: PACKAGE_NAME,
  release_url: PROJECT_REPOSITORY_URL,
  update_available: false,
})

export const createVersionService = (options: VersionServiceOptions = {}): VersionService => {
  const currentVersion = options.currentVersion ?? readPackageVersion()
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? 5_000
  const cacheTtlMs = options.cacheTtlMs ?? 60 * 60 * 1_000
  const registryUrl = options.registryUrl ?? 'https://registry.npmjs.org/'
  const latestUrl = `${registryUrl.replace(/\/+$/, '')}/${encodeURIComponent(PACKAGE_NAME)}/latest`
  const info = buildVersionInfo(currentVersion)
  let cached: { info: VersionInfoPayload; expiresAt: number } | null = null
  let inFlight: Promise<VersionInfoPayload> | null = null

  const lookupLatest = async (): Promise<VersionInfoPayload> => {
    const signal = AbortSignal.timeout(timeoutMs)
    try {
      const response = await fetchImpl(latestUrl, {
        headers: { accept: 'application/json' },
        signal,
      })
      if (!response.ok) {
        throw new VersionLookupError(`npm registry returned HTTP ${response.status}`)
      }
      const body: unknown = await response.json()
      if (
        !body ||
        typeof body !== 'object' ||
        !('version' in body) ||
        typeof body.version !== 'string'
      ) {
        throw new VersionLookupError('npm registry returned an invalid package version')
      }
      const comparison = compareSemverVersions(body.version, currentVersion)
      if (comparison === null) {
        throw new VersionLookupError('npm registry returned an invalid package version')
      }
      return { ...info, latest_version: body.version, update_available: comparison > 0 }
    } catch (error) {
      if (error instanceof VersionLookupError) throw error
      throw new VersionLookupError(
        signal.aborted
          ? 'npm version lookup timed out'
          : 'Could not retrieve the latest npm version',
        error
      )
    }
  }

  return {
    getVersionInfo: async () => info,
    getLatestVersionInfo: () => {
      if (cached && cached.expiresAt > now()) return Promise.resolve(cached.info)
      if (inFlight) return inFlight
      inFlight = lookupLatest()
        .then((latestInfo) => {
          cached = { info: latestInfo, expiresAt: now() + cacheTtlMs }
          return latestInfo
        })
        .finally(() => {
          inFlight = null
        })
      return inFlight
    },
  }
}
