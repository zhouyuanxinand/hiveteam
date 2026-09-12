import type {
  SkillChangeAction,
  SkillChangeOperation,
  SkillPackChangeIntent,
} from '../shared/skill-packs.js'

export interface SkillFileState {
  content: string | null
  fingerprint: string
}

export interface SkillLinkState {
  fingerprint: string
  target: string | null
}

export type InternalSkillChangeOperation =
  | {
      after: SkillFileState
      before: SkillFileState
      kind: 'write_file'
      path: string
      publicKind: 'write_config' | 'write_lock'
    }
  | {
      after: SkillLinkState
      before: SkillLinkState
      kind: 'placement'
      path: string
      publicKind: 'create_placement' | 'remove_placement'
      releaseId: string
      skillName: string
    }

export interface InternalSkillChangePlan {
  action: SkillChangeAction
  beforeFingerprint: string
  createdAt: number
  expiresAt: number
  id: string
  intent: SkillPackChangeIntent
  internalOperations: InternalSkillChangeOperation[]
  observedFiles: Array<{ path: string; state: SkillFileState }>
  observedLinks: Array<{ path: string; state: SkillLinkState }>
  operations: SkillChangeOperation[]
  workspaceId: string
}

export interface SkillChangeJournal {
  completedOperationIndexes: number[]
  direction: 'apply' | 'undo'
  pendingOperationIndex: number | null
}
