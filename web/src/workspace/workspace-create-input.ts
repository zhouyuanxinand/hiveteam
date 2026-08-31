import type { WorkspaceLanguage } from '../../../src/shared/types.js'

export interface WorkspaceCreateInput {
  commandPresetId: string | null
  language?: WorkspaceLanguage
  name: string
  path: string
  startupCommand?: string
}
