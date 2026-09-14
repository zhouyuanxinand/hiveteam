import type { FsProbeResponse } from '../api.js'

export type DesktopFolderProbeErrorCode =
  | 'not_directory'
  | 'path_unavailable'
  | 'runtime_unavailable'

export type DesktopFolderProbeResult =
  | { ok: true; probe: FsProbeResponse }
  | { error_code: DesktopFolderProbeErrorCode; ok: false }

export interface HiveDesktopBridge {
  probeDroppedFolder: (file: File) => Promise<DesktopFolderProbeResult>
}

declare global {
  interface Window {
    hiveDesktop?: HiveDesktopBridge
  }
}

export const getDesktopBridge = (): HiveDesktopBridge | null => window.hiveDesktop ?? null
