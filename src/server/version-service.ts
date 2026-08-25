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
}

const buildVersionInfo = (currentVersion: string): VersionInfoPayload => ({
  current_version: currentVersion,
  install_hint: 'git pull',
  latest_version: currentVersion,
  package_name: PACKAGE_NAME,
  release_url: PROJECT_REPOSITORY_URL,
  update_available: false,
})

export const createVersionService = (): VersionService => {
  const currentVersion = readPackageVersion()
  const info = buildVersionInfo(currentVersion)

  return {
    getVersionInfo: async () => info,
  }
}
