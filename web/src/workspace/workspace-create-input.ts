import type { WorkspaceLanguage } from '../../../src/shared/types.js'

export interface WorkspaceCreateInput {
  initializationMode?: 'basic' | 'packs'
  autostartOrchestrator?: boolean
  commandPresetId: string | null
  language?: WorkspaceLanguage
  name: string
  path: string
  startupCommand?: string
}
