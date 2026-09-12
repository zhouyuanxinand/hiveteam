import { describeSkillPackSource } from '../shared/skill-pack-source.js'
import type {
  EffectiveSkillObservation,
  SkillChangeOperation,
  SkillChangePlan,
  SkillChangeReceipt,
  SkillMemberInspection,
  SkillPackRelease,
  SkillRootObservation,
  WorkspaceSkillInspection,
} from '../shared/skill-packs.js'

const serializeSource = (source: SkillPackRelease['source']) =>
  describeSkillPackSource(source).payload

const serializeOperation = (operation: SkillChangeOperation) => ({
  after_fingerprint: operation.afterFingerprint,
  before_fingerprint: operation.beforeFingerprint,
  kind: operation.kind,
  path: operation.path,
  skill_name: operation.skillName,
})

export const serializeSkillChangePlan = (plan: SkillChangePlan) => ({
  action: plan.action,
  before_fingerprint: plan.beforeFingerprint,
  created_at: plan.createdAt,
  expires_at: plan.expiresAt,
  id: plan.id,
  intent: {
    action: plan.intent.action,
    pack_name: plan.intent.packName,
    ...(plan.intent.action === 'remove'
      ? {}
      : {
          native_exposure: plan.intent.nativeExposure,
          profiles: plan.intent.profiles,
          release_id: plan.intent.releaseId,
        }),
  },
  operations: plan.operations.map(serializeOperation),
  status: plan.status,
  workspace_id: plan.workspaceId,
})

export const serializeSkillChangeReceipt = (receipt: SkillChangeReceipt) => ({
  completed_at: receipt.completedAt,
  error: receipt.error,
  id: receipt.id,
  operations: receipt.operations.map(serializeOperation),
  plan_id: receipt.planId,
  started_at: receipt.startedAt,
  state: receipt.state,
  undo_available: receipt.undoAvailable,
  workspace_id: receipt.workspaceId,
})

const serializeRoot = (root: SkillRootObservation) => ({
  adapter_id: root.adapterId,
  error: root.error,
  id: root.id,
  label: root.label,
  path: root.path,
  scope: root.scope,
  status: root.status,
  verified: root.verified,
})

const serializeSkill = (skill: EffectiveSkillObservation) => ({
  canonical_path: skill.canonicalPath,
  conflict: skill.conflict,
  contains_scripts: skill.containsScripts,
  description: skill.description,
  directory_name: skill.directoryName,
  explicit_only: skill.explicitOnly,
  instruction_digest: skill.instructionDigest,
  name: skill.name,
  root_ids: skill.rootIds,
  source_scopes: skill.sourceScopes,
  validation_errors: skill.validationErrors,
})

const serializeMember = (member: SkillMemberInspection) => ({
  agent_id: member.agentId,
  command_preset_id: member.commandPresetId,
  delivery_status: member.deliveryStatus,
  error: member.error,
  name: member.name,
  native_discovery_status: member.nativeDiscoveryStatus,
  profile: member.profile,
  restart_required: member.restartRequired,
  roots: member.roots.map(serializeRoot),
  scan_status: member.scanStatus,
  skills: member.skills.map(serializeSkill),
  status: member.status,
})

export const serializeWorkspaceSkillInspection = (inspection: WorkspaceSkillInspection) => ({
  configuration: {
    native_exposure: inspection.configuration.nativeExposure,
    packs: inspection.configuration.packs.map((pack) => ({
      enabled: pack.enabled,
      name: pack.name,
      source: serializeSource(pack.source),
    })),
    profiles: inspection.configuration.profiles,
    version: inspection.configuration.version,
  },
  conflicts: inspection.conflicts.map((conflict) => ({
    member_ids: conflict.memberIds,
    name: conflict.name,
    paths: conflict.paths,
  })),
  lock: {
    packs: inspection.lock.packs.map((pack) => ({
      cache_key: pack.cacheKey,
      content_digest: pack.contentDigest,
      name: pack.name,
      release_id: pack.releaseId,
      resolved_revision: pack.resolvedRevision,
      skills: pack.skills.map((skill) => ({
        contains_scripts: skill.containsScripts,
        content_digest: skill.contentDigest,
        explicit_only: skill.explicitOnly,
        instruction_digest: skill.instructionDigest,
        name: skill.name,
        relative_path: skill.relativePath,
      })),
      source_type: pack.sourceType,
      source_uri: pack.sourceUri,
    })),
    version: inspection.lock.version,
  },
  members: inspection.members.map(serializeMember),
  plans: inspection.plans.map(serializeSkillChangePlan),
  receipts: inspection.receipts.map(serializeSkillChangeReceipt),
  scanned_at: inspection.scannedAt,
  summary: {
    conflict_count: inspection.summary.conflictCount,
    effective_skill_count: inspection.summary.effectiveSkillCount,
    invalid_skill_count: inspection.summary.invalidSkillCount,
    member_count: inspection.summary.memberCount,
  },
  workspace_id: inspection.workspaceId,
})

export const serializeSkillPackRelease = (release: SkillPackRelease) => ({
  cache_key: release.cacheKey,
  content_digest: release.contentDigest,
  created_at: release.createdAt,
  id: release.id,
  manifest: {
    executable_paths: release.manifest.executablePaths,
    file_count: release.manifest.fileCount,
    skills: release.manifest.skills.map((skill) => ({
      contains_scripts: skill.containsScripts,
      content_digest: skill.contentDigest,
      description: skill.description,
      explicit_only: skill.explicitOnly,
      file_count: skill.fileCount,
      instruction_digest: skill.instructionDigest,
      name: skill.name,
      relative_path: skill.relativePath,
      script_paths: skill.scriptPaths,
      total_bytes: skill.totalBytes,
    })),
    total_bytes: release.manifest.totalBytes,
  },
  pack_name: release.packName,
  resolved_revision: release.resolvedRevision,
  source: serializeSource(release.source),
  source_dirty: release.sourceDirty,
  source_uri: release.sourceUri,
})
