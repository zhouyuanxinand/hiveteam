import type {
  EffectiveSkillObservation,
  SkillChangePlan,
  SkillChangeReceipt,
  SkillMemberInspection,
  SkillNameConflict,
  SkillPackChangeIntent,
  SkillPackRelease,
  SkillPackSource,
  SkillRootObservation,
  WorkspaceSkillInspection,
  WorkspaceSkillPackConfiguration,
  WorkspaceSkillPackLock,
} from '../../src/shared/skill-packs.js'
import { apiFetch, readErrorMessage } from './api.js'

interface SkillRootObservationPayload {
  adapter_id: string
  error: string | null
  id: string
  label: string
  path: string
  scope: SkillRootObservation['scope']
  status: SkillRootObservation['status']
  verified: boolean
}

interface EffectiveSkillObservationPayload {
  canonical_path: string
  conflict: boolean
  contains_scripts: boolean
  description: string | null
  directory_name: string
  explicit_only: boolean
  instruction_digest: string
  name: string
  root_ids: string[]
  source_scopes: EffectiveSkillObservation['sourceScopes']
  validation_errors: string[]
}

interface SkillMemberInspectionPayload {
  agent_id: string
  command_preset_id: string | null
  delivery_status: SkillMemberInspection['deliveryStatus']
  error: string | null
  name: string
  native_discovery_status: SkillMemberInspection['nativeDiscoveryStatus']
  profile: SkillMemberInspection['profile']
  restart_required: boolean
  roots: SkillRootObservationPayload[]
  scan_status: SkillMemberInspection['scanStatus']
  skills: EffectiveSkillObservationPayload[]
  status: SkillMemberInspection['status']
}

interface WorkspaceSkillInspectionPayload {
  configuration?: WorkspaceSkillPackConfigurationPayload
  conflicts: Array<{ member_ids: string[]; name: string; paths: string[] }>
  lock?: WorkspaceSkillPackLockPayload
  members: SkillMemberInspectionPayload[]
  plans?: SkillChangePlanPayload[]
  receipts?: SkillChangeReceiptPayload[]
  scanned_at: number
  summary: {
    conflict_count: number
    effective_skill_count: number
    invalid_skill_count: number
    member_count: number
  }
  workspace_id: string
}

interface WorkspaceSkillPackConfigurationPayload {
  native_exposure: string[]
  packs: Array<{ enabled: boolean; name: string; source: SkillPackSource }>
  profiles: WorkspaceSkillPackConfiguration['profiles']
  version: 1
}

interface WorkspaceSkillPackLockPayload {
  packs: Array<{
    cache_key: string
    content_digest: string
    name: string
    release_id: string
    resolved_revision: string
    skills: Array<{
      contains_scripts: boolean
      content_digest: string
      explicit_only: boolean
      instruction_digest: string
      name: string
      relative_path: string
    }>
    source_type: SkillPackSource['type']
    source_uri: string
  }>
  version: 1
}

interface SkillChangeOperationPayload {
  after_fingerprint: string
  before_fingerprint: string
  kind: SkillChangePlan['operations'][number]['kind']
  path: string
  skill_name: string | null
}

interface SkillChangePlanPayload {
  action: SkillChangePlan['action']
  before_fingerprint: string
  created_at: number
  expires_at: number
  id: string
  intent: {
    action: SkillPackChangeIntent['action']
    native_exposure?: string[]
    pack_name: string
    profiles?: Partial<WorkspaceSkillPackConfiguration['profiles']>
    release_id?: string
  }
  operations: SkillChangeOperationPayload[]
  status: SkillChangePlan['status']
  workspace_id: string
}

interface SkillChangeReceiptPayload {
  completed_at: number | null
  error: string | null
  id: string
  operations: SkillChangeOperationPayload[]
  plan_id: string
  started_at: number
  state: SkillChangeReceipt['state']
  undo_available: boolean
  workspace_id: string
}

interface SkillPackReleasePayload {
  cache_key: string
  content_digest: string
  created_at: number
  id: string
  manifest: {
    executable_paths: string[]
    file_count: number
    skills: Array<{
      contains_scripts: boolean
      content_digest: string
      description: string
      explicit_only: boolean
      file_count: number
      instruction_digest: string
      name: string
      relative_path: string
      script_paths: string[]
      total_bytes: number
    }>
    total_bytes: number
  }
  pack_name: string
  resolved_revision: string
  source: SkillPackSource
  source_dirty: boolean
  source_uri: string
}

const fromSkillRootPayload = (root: SkillRootObservationPayload): SkillRootObservation => ({
  adapterId: root.adapter_id,
  error: root.error,
  id: root.id,
  label: root.label,
  path: root.path,
  scope: root.scope,
  status: root.status,
  verified: root.verified,
})

const fromEffectiveSkillPayload = (
  skill: EffectiveSkillObservationPayload
): EffectiveSkillObservation => ({
  canonicalPath: skill.canonical_path,
  conflict: skill.conflict,
  containsScripts: skill.contains_scripts,
  description: skill.description,
  directoryName: skill.directory_name,
  explicitOnly: skill.explicit_only,
  instructionDigest: skill.instruction_digest,
  name: skill.name,
  rootIds: skill.root_ids,
  sourceScopes: skill.source_scopes,
  validationErrors: skill.validation_errors,
})

const fromSkillMemberPayload = (member: SkillMemberInspectionPayload): SkillMemberInspection => ({
  agentId: member.agent_id,
  commandPresetId: member.command_preset_id,
  deliveryStatus: member.delivery_status,
  error: member.error,
  name: member.name,
  nativeDiscoveryStatus: member.native_discovery_status,
  profile: member.profile,
  restartRequired: member.restart_required,
  roots: member.roots.map(fromSkillRootPayload),
  scanStatus: member.scan_status,
  skills: member.skills.map(fromEffectiveSkillPayload),
  status: member.status,
})

const fromSkillChangeOperationPayload = (
  operation: SkillChangeOperationPayload
): SkillChangePlan['operations'][number] => ({
  afterFingerprint: operation.after_fingerprint,
  beforeFingerprint: operation.before_fingerprint,
  kind: operation.kind,
  path: operation.path,
  skillName: operation.skill_name,
})

const fromSkillChangePlanPayload = (plan: SkillChangePlanPayload): SkillChangePlan => {
  const intent: SkillPackChangeIntent =
    plan.intent.action === 'remove'
      ? { action: 'remove', packName: plan.intent.pack_name }
      : {
          action: plan.intent.action,
          nativeExposure: plan.intent.native_exposure ?? [],
          packName: plan.intent.pack_name,
          profiles: plan.intent.profiles ?? {},
          releaseId: plan.intent.release_id ?? '',
        }
  return {
    action: plan.action,
    beforeFingerprint: plan.before_fingerprint,
    createdAt: plan.created_at,
    expiresAt: plan.expires_at,
    id: plan.id,
    intent,
    operations: plan.operations.map(fromSkillChangeOperationPayload),
    status: plan.status,
    workspaceId: plan.workspace_id,
  }
}

const fromSkillChangeReceiptPayload = (receipt: SkillChangeReceiptPayload): SkillChangeReceipt => ({
  completedAt: receipt.completed_at,
  error: receipt.error,
  id: receipt.id,
  operations: receipt.operations.map(fromSkillChangeOperationPayload),
  planId: receipt.plan_id,
  startedAt: receipt.started_at,
  state: receipt.state,
  undoAvailable: receipt.undo_available,
  workspaceId: receipt.workspace_id,
})

const fromSkillPackConfigurationPayload = (
  configuration?: WorkspaceSkillPackConfigurationPayload
): WorkspaceSkillPackConfiguration => ({
  nativeExposure: configuration?.native_exposure ?? [],
  packs: configuration?.packs ?? [],
  profiles: configuration?.profiles ?? {
    coder: [],
    custom: [],
    orchestrator: [],
    reviewer: [],
    tester: [],
  },
  version: 1,
})

const fromSkillPackLockPayload = (
  lock?: WorkspaceSkillPackLockPayload
): WorkspaceSkillPackLock => ({
  packs: (lock?.packs ?? []).map((pack) => ({
    cacheKey: pack.cache_key,
    contentDigest: pack.content_digest,
    name: pack.name,
    releaseId: pack.release_id,
    resolvedRevision: pack.resolved_revision,
    skills: pack.skills.map((skill) => ({
      containsScripts: skill.contains_scripts,
      contentDigest: skill.content_digest,
      explicitOnly: skill.explicit_only,
      instructionDigest: skill.instruction_digest,
      name: skill.name,
      relativePath: skill.relative_path,
    })),
    sourceType: pack.source_type,
    sourceUri: pack.source_uri,
  })),
  version: 1,
})

const fromWorkspaceSkillInspectionPayload = (
  payload: WorkspaceSkillInspectionPayload
): WorkspaceSkillInspection => ({
  configuration: fromSkillPackConfigurationPayload(payload.configuration),
  conflicts: payload.conflicts.map(
    (conflict): SkillNameConflict => ({
      memberIds: conflict.member_ids,
      name: conflict.name,
      paths: conflict.paths,
    })
  ),
  lock: fromSkillPackLockPayload(payload.lock),
  members: payload.members.map(fromSkillMemberPayload),
  plans: (payload.plans ?? []).map(fromSkillChangePlanPayload),
  receipts: (payload.receipts ?? []).map(fromSkillChangeReceiptPayload),
  scannedAt: payload.scanned_at,
  summary: {
    conflictCount: payload.summary.conflict_count,
    effectiveSkillCount: payload.summary.effective_skill_count,
    invalidSkillCount: payload.summary.invalid_skill_count,
    memberCount: payload.summary.member_count,
  },
  workspaceId: payload.workspace_id,
})

const fromSkillPackReleasePayload = (release: SkillPackReleasePayload): SkillPackRelease => ({
  cacheKey: release.cache_key,
  contentDigest: release.content_digest,
  createdAt: release.created_at,
  id: release.id,
  manifest: {
    executablePaths: release.manifest.executable_paths,
    fileCount: release.manifest.file_count,
    skills: release.manifest.skills.map((skill) => ({
      containsScripts: skill.contains_scripts,
      contentDigest: skill.content_digest,
      description: skill.description,
      explicitOnly: skill.explicit_only,
      fileCount: skill.file_count,
      instructionDigest: skill.instruction_digest,
      name: skill.name,
      relativePath: skill.relative_path,
      scriptPaths: skill.script_paths,
      totalBytes: skill.total_bytes,
    })),
    totalBytes: release.manifest.total_bytes,
  },
  packName: release.pack_name,
  resolvedRevision: release.resolved_revision,
  source: release.source,
  sourceDirty: release.source_dirty,
  sourceUri: release.source_uri,
})

const requestWorkspaceSkillInspection = async (
  workspaceId: string,
  forceScan: boolean
): Promise<WorkspaceSkillInspection> => {
  const suffix = forceScan ? '/scan' : ''
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/skill-packs${suffix}`,
    forceScan ? { method: 'POST' } : undefined
  )
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to inspect workspace Skills'))
  }
  return fromWorkspaceSkillInspectionPayload(
    (await response.json()) as WorkspaceSkillInspectionPayload
  )
}

export const getWorkspaceSkillInspection = (workspaceId: string) =>
  requestWorkspaceSkillInspection(workspaceId, false)

export const scanWorkspaceSkills = (workspaceId: string) =>
  requestWorkspaceSkillInspection(workspaceId, true)

export const resolveWorkspaceSkillPack = async (
  workspaceId: string,
  input: { name: string; source: SkillPackSource }
): Promise<SkillPackRelease> => {
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/skill-packs/resolve`,
    {
      body: JSON.stringify(input),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }
  )
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Failed to resolve Skill Pack'))
  return fromSkillPackReleasePayload((await response.json()) as SkillPackReleasePayload)
}

export const createWorkspaceSkillChangePlan = async (
  workspaceId: string,
  intent: SkillPackChangeIntent
): Promise<SkillChangePlan> => {
  const body =
    intent.action === 'remove'
      ? { action: intent.action, pack_name: intent.packName }
      : {
          action: intent.action,
          native_exposure: intent.nativeExposure,
          pack_name: intent.packName,
          profiles: intent.profiles,
          release_id: intent.releaseId,
        }
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/skill-packs/plans`,
    {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }
  )
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Failed to create Change Plan'))
  return fromSkillChangePlanPayload((await response.json()) as SkillChangePlanPayload)
}

export const applyWorkspaceSkillChangePlan = async (
  workspaceId: string,
  planId: string
): Promise<SkillChangeReceipt> => {
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/skill-packs/plans/${encodeURIComponent(planId)}/apply`,
    { method: 'POST' }
  )
  if (!response.ok) throw new Error(await readErrorMessage(response, 'Failed to apply Change Plan'))
  return fromSkillChangeReceiptPayload((await response.json()) as SkillChangeReceiptPayload)
}

export const undoWorkspaceSkillChangeReceipt = async (
  workspaceId: string,
  receiptId: string
): Promise<SkillChangeReceipt> => {
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/skill-packs/receipts/${encodeURIComponent(receiptId)}/undo`,
    { method: 'POST' }
  )
  if (!response.ok) throw new Error(await readErrorMessage(response, 'Failed to undo change'))
  return fromSkillChangeReceiptPayload((await response.json()) as SkillChangeReceiptPayload)
}
