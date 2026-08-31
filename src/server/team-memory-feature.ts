import type { SettingsStore } from './settings-store.js'

/** Persistent per-workspace switches for the local Team Memory feature. */
export const workspaceMemoryEnabledKey = (workspaceId: string) =>
  `workspace.${workspaceId}.memory.enabled`

/**
 * Automatic Dream preparation is deliberately opt-in. A Dream can still be
 * prepared manually; enabling this switch only lets the local runtime queue a
 * visible review after the workspace has been idle.
 */
export const workspaceMemoryDreamEnabledKey = (workspaceId: string) =>
  `workspace.${workspaceId}.memory.dream.enabled`

export const workspaceMemoryDreamLastScheduledAtKey = (workspaceId: string) =>
  `workspace.${workspaceId}.memory.dream.last_scheduled_at`

export const readWorkspaceMemoryEnabled = (raw: string | null | undefined) => raw !== 'false'

export const serializeWorkspaceMemoryEnabled = (enabled: boolean) => (enabled ? 'true' : 'false')

export const readWorkspaceMemoryDreamEnabled = (raw: string | null | undefined) => raw === 'true'

export const serializeWorkspaceMemoryDreamEnabled = (enabled: boolean) =>
  enabled ? 'true' : 'false'

export const isWorkspaceMemoryEnabled = (settings: SettingsStore, workspaceId: string) =>
  readWorkspaceMemoryEnabled(settings.getAppState(workspaceMemoryEnabledKey(workspaceId))?.value)

export const setWorkspaceMemoryEnabled = (
  settings: SettingsStore,
  workspaceId: string,
  enabled: boolean
) =>
  settings.setAppState(
    workspaceMemoryEnabledKey(workspaceId),
    serializeWorkspaceMemoryEnabled(enabled)
  )

export const isWorkspaceMemoryDreamEnabled = (settings: SettingsStore, workspaceId: string) =>
  readWorkspaceMemoryDreamEnabled(
    settings.getAppState(workspaceMemoryDreamEnabledKey(workspaceId))?.value
  )

export const setWorkspaceMemoryDreamEnabled = (
  settings: SettingsStore,
  workspaceId: string,
  enabled: boolean
) =>
  settings.setAppState(
    workspaceMemoryDreamEnabledKey(workspaceId),
    serializeWorkspaceMemoryDreamEnabled(enabled)
  )

export const readWorkspaceMemoryDreamLastScheduledAt = (
  settings: SettingsStore,
  workspaceId: string
) => {
  const value = Number(
    settings.getAppState(workspaceMemoryDreamLastScheduledAtKey(workspaceId))?.value ?? ''
  )
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null
}

export const setWorkspaceMemoryDreamLastScheduledAt = (
  settings: SettingsStore,
  workspaceId: string,
  timestamp: number
) =>
  settings.setAppState(
    workspaceMemoryDreamLastScheduledAtKey(workspaceId),
    String(Math.max(0, Math.floor(timestamp)))
  )
