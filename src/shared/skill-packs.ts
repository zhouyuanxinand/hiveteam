import type { AgentStatus, WorkerRole } from './types.js'

export const skillSourceScopes = ['workspace', 'user', 'system'] as const
export type SkillSourceScope = (typeof skillSourceScopes)[number]

export const skillRootStatuses = ['found', 'missing', 'unreadable'] as const
export type SkillRootStatus = (typeof skillRootStatuses)[number]

export const skillScanStatuses = ['ready', 'empty', 'partial', 'failed'] as const
export type SkillScanStatus = (typeof skillScanStatuses)[number]

export const skillDeliveryStatuses = ['ready', 'not_configured', 'failed'] as const
export type SkillDeliveryStatus = (typeof skillDeliveryStatuses)[number]

export const skillNativeDiscoveryStatuses = [
  'ready',
  'prompt_only',
  'restart_required',
  'conflict',
  'unverified',
] as const
export type SkillNativeDiscoveryStatus = (typeof skillNativeDiscoveryStatuses)[number]

export interface SkillRootObservation {
  adapterId: string
  error: string | null
  id: string
  label: string
  path: string
  scope: SkillSourceScope
  status: SkillRootStatus
  verified: boolean
}

export interface EffectiveSkillObservation {
  canonicalPath: string
  conflict: boolean
  containsScripts: boolean
  description: string | null
  directoryName: string
  explicitOnly: boolean
  instructionDigest: string
  name: string
  rootIds: string[]
  sourceScopes: SkillSourceScope[]
  validationErrors: string[]
}

export interface SkillMemberInspection {
  agentId: string
  commandPresetId: string | null
  deliveryStatus: SkillDeliveryStatus
  error: string | null
  name: string
  nativeDiscoveryStatus: SkillNativeDiscoveryStatus
  profile: WorkerRole | 'orchestrator'
  restartRequired: boolean
  roots: SkillRootObservation[]
  scanStatus: SkillScanStatus
  skills: EffectiveSkillObservation[]
  status: AgentStatus
}

export interface SkillNameConflict {
  memberIds: string[]
  name: string
  paths: string[]
}

export interface WorkspaceSkillInspection {
  conflicts: SkillNameConflict[]
  configuration: WorkspaceSkillPackConfiguration
  lock: WorkspaceSkillPackLock
  members: SkillMemberInspection[]
  plans: SkillChangePlan[]
  receipts: SkillChangeReceipt[]
  scannedAt: number
  summary: {
    conflictCount: number
    effectiveSkillCount: number
    invalidSkillCount: number
    memberCount: number
  }
  workspaceId: string
}

export type SkillPackSource =
  | { ref: string; repository: string; type: 'github' }
  | { ref: string; type: 'git'; url: string }
  | { path: string; type: 'local' }

export interface SkillPackManifestSkill {
  containsScripts: boolean
  contentDigest: string
  description: string
  explicitOnly: boolean
  fileCount: number
  instructionDigest: string
  name: string
  relativePath: string
  scriptPaths: string[]
  totalBytes: number
}

export interface SkillPackManifest {
  executablePaths: string[]
  fileCount: number
  skills: SkillPackManifestSkill[]
  totalBytes: number
}

export interface SkillPackRelease {
  cacheKey: string
  contentDigest: string
  createdAt: number
  id: string
  manifest: SkillPackManifest
  packName: string
  resolvedRevision: string
  source: SkillPackSource
  sourceDirty: boolean
  sourceUri: string
}

export interface ResolveSkillPackInput {
  packName: string
  source: SkillPackSource
}

export const skillProfileNames = ['orchestrator', 'coder', 'reviewer', 'tester', 'custom'] as const
export type SkillProfileName = (typeof skillProfileNames)[number]

export type SkillProfiles = Record<SkillProfileName, string[]>

export interface WorkspaceSkillPackBinding {
  enabled: boolean
  name: string
  source: SkillPackSource
}

export interface WorkspaceSkillPackConfiguration {
  nativeExposure: string[]
  packs: WorkspaceSkillPackBinding[]
  profiles: SkillProfiles
  version: 1
}

export interface WorkspaceSkillPackLockSkill {
  containsScripts: boolean
  contentDigest: string
  explicitOnly: boolean
  instructionDigest: string
  name: string
  relativePath: string
}

export interface WorkspaceSkillPackLockEntry {
  cacheKey: string
  contentDigest: string
  name: string
  releaseId: string
  resolvedRevision: string
  skills: WorkspaceSkillPackLockSkill[]
  sourceType: SkillPackSource['type']
  sourceUri: string
}

export interface WorkspaceSkillPackLock {
  packs: WorkspaceSkillPackLockEntry[]
  version: 1
}

export const skillChangeActions = ['bind', 'update', 'remove'] as const
export type SkillChangeAction = (typeof skillChangeActions)[number]

export type SkillPackChangeIntent =
  | {
      action: 'bind' | 'update'
      nativeExposure: string[]
      packName: string
      profiles: Partial<SkillProfiles>
      releaseId: string
    }
  | { action: 'remove'; packName: string }

export interface SkillChangeOperation {
  afterFingerprint: string
  beforeFingerprint: string
  kind: 'write_config' | 'write_lock' | 'create_placement' | 'remove_placement'
  path: string
  skillName: string | null
}

export const skillChangeAttemptStates = [
  'applying',
  'applied',
  'rolled_back',
  'failed',
  'recovery_required',
] as const
export type SkillChangeAttemptState = (typeof skillChangeAttemptStates)[number]

export interface SkillChangePlan {
  action: SkillChangeAction
  beforeFingerprint: string
  createdAt: number
  expiresAt: number
  id: string
  intent: SkillPackChangeIntent
  operations: SkillChangeOperation[]
  status: 'ready' | 'expired' | 'applied'
  workspaceId: string
}

export interface SkillChangeReceipt {
  completedAt: number | null
  error: string | null
  id: string
  operations: SkillChangeOperation[]
  planId: string
  startedAt: number
  state: SkillChangeAttemptState
  undoAvailable: boolean
  workspaceId: string
}

export interface WorkspaceSkillPackState {
  configuration: WorkspaceSkillPackConfiguration
  lock: WorkspaceSkillPackLock
  plans: SkillChangePlan[]
  receipts: SkillChangeReceipt[]
}

export interface ResolvedSkillActivation {
  deliveryMode: 'inline'
  instructionSnapshot: string
  packName: string
  payloadDigest: string
  releaseId: string
  skillDigest: string
  skillName: string
}

export interface DispatchSkillActivation extends ResolvedSkillActivation {
  createdAt: number
  dispatchId: string
}

export interface AvailableSkill {
  description: string
  explicitOnly: boolean
  name: string
  qualifiedName: string
  releaseId: string
}
