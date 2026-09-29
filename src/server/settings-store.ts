import {
  createPublicAppStateStore,
  type InternalAppStateStore,
  type PublicAppStateStore,
} from './app-state-policy.js'
import { type AppStateRecord, type AppStateValue, createAppStateStore } from './app-state-store.js'
import {
  type CommandPresetInput,
  type CommandPresetRecord,
  createCommandPresetStore,
} from './command-preset-store.js'
import {
  createRoleTemplateStore,
  type RoleTemplateInput,
  type RoleTemplateRecord,
} from './role-template-store.js'
import type { Database } from './sqlite.js'

export interface SettingsStore {
  createCommandPreset: (input: CommandPresetInput) => CommandPresetRecord
  createRoleTemplate: (input: RoleTemplateInput) => RoleTemplateRecord
  deleteCommandPreset: (id: string) => void
  deleteRoleTemplate: (id: string) => void
  internalAppState: InternalAppStateStore
  publicAppState: PublicAppStateStore
  getCommandPreset: (id: string) => CommandPresetRecord | undefined
  listCommandPresets: () => CommandPresetRecord[]
  listRoleTemplates: () => RoleTemplateRecord[]
  updateCommandPreset: (id: string, input: CommandPresetInput) => CommandPresetRecord
  updateRoleTemplate: (id: string, input: RoleTemplateInput) => RoleTemplateRecord
}

export type {
  AppStateRecord,
  AppStateValue,
  CommandPresetInput,
  CommandPresetRecord,
  RoleTemplateInput,
  RoleTemplateRecord,
}

export const createSettingsStore = (db: Database): SettingsStore => {
  const appStateStore = createAppStateStore(db)
  const commandPresetStore = createCommandPresetStore(db)
  const roleTemplateStore = createRoleTemplateStore(db)

  return {
    createCommandPreset: commandPresetStore.create,
    createRoleTemplate: roleTemplateStore.create,
    deleteCommandPreset: commandPresetStore.remove,
    deleteRoleTemplate: roleTemplateStore.remove,
    internalAppState: appStateStore,
    publicAppState: createPublicAppStateStore(appStateStore),
    getCommandPreset: commandPresetStore.get,
    listCommandPresets: commandPresetStore.list,
    listRoleTemplates: roleTemplateStore.list,
    updateCommandPreset: commandPresetStore.update,
    updateRoleTemplate: roleTemplateStore.update,
  }
}
