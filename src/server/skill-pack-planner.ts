import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import type {
  SkillChangeOperation,
  SkillPackChangeIntent,
  SkillPackRelease,
  WorkspaceSkillPackConfiguration,
  WorkspaceSkillPackLock,
  WorkspaceSkillPackLockEntry,
} from '../shared/skill-packs.js'
import { skillProfileNames } from '../shared/skill-packs.js'
import { isPathWithinRoot } from './fs-sandbox.js'
import type { SkillPackChangeStore, SkillPlacementRecord } from './skill-pack-change-store.js'
import type {
  InternalSkillChangeOperation,
  InternalSkillChangePlan,
  SkillFileState,
  SkillLinkState,
} from './skill-pack-change-types.js'
import {
  fingerprintContent,
  readWorkspaceSkillFiles,
  serializeWorkspaceSkillConfiguration,
  serializeWorkspaceSkillLock,
} from './skill-pack-config.js'
import { fingerprintLinkTarget, observeLinkState } from './skill-pack-filesystem.js'
import { SkillPackChangeError } from './skill-pack-operation-errors.js'
import type { createSkillPackReleaseStore } from './skill-pack-release-store.js'
import type { SkillPackResolver } from './skill-pack-resolver.js'

const MAX_NATIVE_EXPOSURE = 12

interface SkillPackPlannerDependencies {
  changeStore: SkillPackChangeStore
  getWorkspacePath: (workspaceId: string) => string
  releaseStore: ReturnType<typeof createSkillPackReleaseStore>
  resolver: SkillPackResolver
}

interface DesiredPlacement {
  releaseId: string
  skillName: string
  sourcePath: string
  targetPath: string
}

const cloneConfiguration = (
  configuration: WorkspaceSkillPackConfiguration
): WorkspaceSkillPackConfiguration => ({
  nativeExposure: [...configuration.nativeExposure],
  packs: configuration.packs.map((pack) => ({ ...pack, source: { ...pack.source } })),
  profiles: {
    coder: [...configuration.profiles.coder],
    custom: [...configuration.profiles.custom],
    orchestrator: [...configuration.profiles.orchestrator],
    reviewer: [...configuration.profiles.reviewer],
    tester: [...configuration.profiles.tester],
  },
  version: 1,
})

const cloneLock = (lock: WorkspaceSkillPackLock): WorkspaceSkillPackLock => ({
  packs: lock.packs.map((pack) => ({
    ...pack,
    skills: pack.skills.map((skill) => ({ ...skill })),
  })),
  version: 1,
})

const lockEntryForRelease = (
  packName: string,
  release: SkillPackRelease
): WorkspaceSkillPackLockEntry => ({
  cacheKey: release.cacheKey,
  contentDigest: release.contentDigest,
  name: packName,
  releaseId: release.id,
  resolvedRevision: release.resolvedRevision,
  skills: release.manifest.skills.map((skill) => ({
    containsScripts: skill.containsScripts,
    contentDigest: skill.contentDigest,
    explicitOnly: skill.explicitOnly,
    instructionDigest: skill.instructionDigest,
    name: skill.name,
    relativePath: skill.relativePath,
  })),
  sourceType: release.source.type,
  sourceUri: release.sourceUri,
})

const replacePackReferences = (
  current: string[],
  packName: string,
  selected: string[] | undefined,
  validSkillNames: Set<string>
) => {
  if (!selected) return [...current]
  const prefix = `${packName}/`
  const preserved = current.filter((reference) => !reference.startsWith(prefix))
  const normalized = selected.map((reference) => {
    const qualified = reference.includes('/') ? reference : `${packName}/${reference}`
    if (!qualified.startsWith(prefix)) {
      throw new SkillPackChangeError(
        'invalid_intent',
        `Profile selection cannot modify another Pack: ${reference}`
      )
    }
    const skillName = qualified.slice(prefix.length)
    if (!validSkillNames.has(skillName)) {
      throw new SkillPackChangeError(
        'invalid_intent',
        `Skill does not exist in ${packName}: ${skillName}`
      )
    }
    return qualified
  })
  return Array.from(new Set([...preserved, ...normalized])).sort()
}

const validateReferences = (
  configuration: WorkspaceSkillPackConfiguration,
  lock: WorkspaceSkillPackLock
) => {
  const enabled = new Set(
    configuration.packs.filter((pack) => pack.enabled).map((pack) => pack.name)
  )
  const valid = new Set(
    lock.packs.flatMap((pack) =>
      enabled.has(pack.name) ? pack.skills.map((skill) => `${pack.name}/${skill.name}`) : []
    )
  )
  const packsBySkillName = new Map<string, string[]>()
  for (const pack of lock.packs.filter((candidate) => enabled.has(candidate.name))) {
    for (const skill of pack.skills) {
      const owners = packsBySkillName.get(skill.name) ?? []
      owners.push(pack.name)
      packsBySkillName.set(skill.name, owners)
    }
  }
  const duplicateNames = Array.from(packsBySkillName)
    .filter(([, owners]) => owners.length > 1)
    .map(([name, owners]) => `${name} (${owners.sort().join(', ')})`)
    .sort()
  if (duplicateNames.length > 0) {
    throw new SkillPackChangeError(
      'skill_name_conflict',
      `Enabled Skill Packs contain duplicate names: ${duplicateNames.join('; ')}`
    )
  }
  for (const [profile, references] of Object.entries(configuration.profiles)) {
    for (const reference of references) {
      if (!valid.has(reference)) {
        throw new SkillPackChangeError(
          'invalid_intent',
          `Unknown Skill reference in ${profile}: ${reference}`
        )
      }
    }
  }
  for (const reference of configuration.nativeExposure) {
    if (!valid.has(reference)) {
      throw new SkillPackChangeError(
        'invalid_intent',
        `Unknown native Skill reference: ${reference}`
      )
    }
  }
  if (configuration.nativeExposure.length > MAX_NATIVE_EXPOSURE) {
    throw new SkillPackChangeError(
      'invalid_intent',
      `Native exposure is limited to ${MAX_NATIVE_EXPOSURE} Skills`
    )
  }
}

const mutateDesiredState = (
  configuration: WorkspaceSkillPackConfiguration,
  lock: WorkspaceSkillPackLock,
  intent: SkillPackChangeIntent,
  release: SkillPackRelease | null
) => {
  const nextConfiguration = cloneConfiguration(configuration)
  const nextLock = cloneLock(lock)
  const existingPack = configuration.packs.find((pack) => pack.name === intent.packName)

  if (intent.action === 'remove') {
    if (!existingPack) {
      throw new SkillPackChangeError('invalid_intent', `Pack is not bound: ${intent.packName}`)
    }
    const prefix = `${intent.packName}/`
    nextConfiguration.packs = nextConfiguration.packs.filter(
      (pack) => pack.name !== intent.packName
    )
    nextLock.packs = nextLock.packs.filter((pack) => pack.name !== intent.packName)
    nextConfiguration.nativeExposure = nextConfiguration.nativeExposure.filter(
      (reference) => !reference.startsWith(prefix)
    )
    for (const profile of skillProfileNames) {
      nextConfiguration.profiles[profile] = nextConfiguration.profiles[profile].filter(
        (reference) => !reference.startsWith(prefix)
      )
    }
    return { nextConfiguration, nextLock }
  }

  if (!release) throw new SkillPackChangeError('release_unavailable', 'Release is unavailable')
  if (intent.action === 'bind' && existingPack) {
    throw new SkillPackChangeError('invalid_intent', `Pack is already bound: ${intent.packName}`)
  }
  if (intent.action === 'update' && !existingPack) {
    throw new SkillPackChangeError('invalid_intent', `Pack is not bound: ${intent.packName}`)
  }
  const skillNames = new Set(release.manifest.skills.map((skill) => skill.name))
  nextConfiguration.packs = [
    ...nextConfiguration.packs.filter((pack) => pack.name !== intent.packName),
    { enabled: true, name: intent.packName, source: release.source },
  ].sort((left, right) => left.name.localeCompare(right.name))
  nextLock.packs = [
    ...nextLock.packs.filter((pack) => pack.name !== intent.packName),
    lockEntryForRelease(intent.packName, release),
  ].sort((left, right) => left.name.localeCompare(right.name))
  for (const profile of skillProfileNames) {
    nextConfiguration.profiles[profile] = replacePackReferences(
      nextConfiguration.profiles[profile],
      intent.packName,
      intent.profiles[profile],
      skillNames
    )
  }
  nextConfiguration.nativeExposure = replacePackReferences(
    nextConfiguration.nativeExposure,
    intent.packName,
    intent.nativeExposure,
    skillNames
  )
  validateReferences(nextConfiguration, nextLock)
  return { nextConfiguration, nextLock }
}

const desiredPlacements = (
  workspacePath: string,
  configuration: WorkspaceSkillPackConfiguration,
  lock: WorkspaceSkillPackLock,
  resolver: SkillPackResolver
) => {
  const byReference = new Map<string, DesiredPlacement>()
  const byShortName = new Map<string, string>()
  for (const reference of configuration.nativeExposure) {
    const slash = reference.indexOf('/')
    const packName = slash > 0 ? reference.slice(0, slash) : ''
    const skillName = slash > 0 ? reference.slice(slash + 1) : ''
    const pack = lock.packs.find((candidate) => candidate.name === packName)
    const skill = pack?.skills.find((candidate) => candidate.name === skillName)
    if (!pack || !skill) {
      throw new SkillPackChangeError('invalid_intent', `Unknown native Skill: ${reference}`)
    }
    const existingReference = byShortName.get(skillName)
    if (existingReference && existingReference !== reference) {
      throw new SkillPackChangeError(
        'placement_conflict',
        `Native Skills share the same name: ${existingReference}, ${reference}`
      )
    }
    byShortName.set(skillName, reference)
    const releasePath = resolver.getReleasePath({ cacheKey: pack.cacheKey })
    const sourcePath = resolve(releasePath, skill.relativePath)
    if (!isPathWithinRoot(releasePath, sourcePath)) {
      throw new SkillPackChangeError('path_unsafe', `Skill path escapes release: ${reference}`)
    }
    byReference.set(reference, {
      releaseId: pack.releaseId,
      skillName,
      sourcePath,
      targetPath: resolve(workspacePath, '.agents', 'skills', skillName),
    })
  }
  return Array.from(byReference.values()).sort((left, right) =>
    left.targetPath.localeCompare(right.targetPath)
  )
}

const publicOperation = (operation: InternalSkillChangeOperation): SkillChangeOperation => ({
  afterFingerprint: operation.after.fingerprint,
  beforeFingerprint: operation.before.fingerprint,
  kind: operation.publicKind,
  path: operation.path,
  skillName: operation.kind === 'placement' ? operation.skillName : null,
})

export const aggregateSkillPlanFingerprint = (
  configFile: SkillFileState,
  lockFile: SkillFileState,
  links: Map<string, SkillLinkState>
) => {
  const digest = createHash('sha256')
  digest.update(`config\0${configFile.fingerprint}\0lock\0${lockFile.fingerprint}\0`)
  for (const [path, state] of [...links].sort(([left], [right]) => left.localeCompare(right))) {
    digest.update(`${path}\0${state.fingerprint}\0`)
  }
  return `sha256:${digest.digest('hex')}`
}

const createPlacementOperations = async (
  workspaceId: string,
  desired: DesiredPlacement[],
  active: SkillPlacementRecord[]
) => {
  const operations: InternalSkillChangeOperation[] = []
  const desiredByTarget = new Map(desired.map((placement) => [placement.targetPath, placement]))
  const activeByTarget = new Map(
    active.map((placement) => [placement.canonicalTargetPath, placement])
  )
  const allPaths = new Set([...desiredByTarget.keys(), ...activeByTarget.keys()])
  const initialStates = new Map<string, SkillLinkState>()

  for (const path of [...allPaths].sort()) initialStates.set(path, await observeLinkState(path))

  for (const placement of active) {
    const observed = initialStates.get(placement.canonicalTargetPath)
    if (!observed || observed.fingerprint !== placement.afterFingerprint) {
      throw new SkillPackChangeError(
        'drift_detected',
        `Owned native Skill placement has drifted: ${placement.canonicalTargetPath}`
      )
    }
    const desiredPlacement = desiredByTarget.get(placement.canonicalTargetPath)
    if (desiredPlacement?.sourcePath === placement.expectedLinkTarget) continue
    operations.push({
      after: { fingerprint: 'missing', target: null },
      before: observed,
      kind: 'placement',
      path: placement.canonicalTargetPath,
      publicKind: 'remove_placement',
      releaseId: placement.releaseId,
      skillName: placement.skillName,
    })
  }

  for (const placement of desired) {
    const activePlacement = activeByTarget.get(placement.targetPath)
    if (activePlacement?.expectedLinkTarget === placement.sourcePath) continue
    const observed = initialStates.get(placement.targetPath) ?? {
      fingerprint: 'missing',
      target: null,
    }
    const expected = activePlacement ? { fingerprint: 'missing', target: null } : observed
    if (!activePlacement && observed.fingerprint !== 'missing') {
      throw new SkillPackChangeError(
        'placement_conflict',
        `Native Skill target is not owned by Hive: ${placement.targetPath}`
      )
    }
    operations.push({
      after: {
        fingerprint: fingerprintLinkTarget(placement.sourcePath),
        target: placement.sourcePath,
      },
      before: expected,
      kind: 'placement',
      path: placement.targetPath,
      publicKind: 'create_placement',
      releaseId: placement.releaseId,
      skillName: placement.skillName,
    })
  }
  return { initialStates, operations, workspaceId }
}

export const createSkillPackPlanner = ({
  changeStore,
  getWorkspacePath,
  releaseStore,
  resolver,
}: SkillPackPlannerDependencies) => {
  const plan = async (workspaceId: string, intent: SkillPackChangeIntent) => {
    if (changeStore.hasIncompleteAttempt(workspaceId)) {
      throw new SkillPackChangeError(
        'recovery_required',
        'An unfinished Skill Pack change must be recovered first'
      )
    }
    const workspacePath = resolve(getWorkspacePath(workspaceId))
    const current = await readWorkspaceSkillFiles(workspacePath)
    const release =
      intent.action === 'remove' ? null : releaseStore.getById(intent.releaseId, intent.packName)
    if (intent.action !== 'remove' && !release) {
      throw new SkillPackChangeError(
        'release_unavailable',
        `Skill Pack release not found: ${intent.releaseId}`
      )
    }
    const { nextConfiguration, nextLock } = mutateDesiredState(
      current.configuration,
      current.lock,
      intent,
      release
    )
    validateReferences(nextConfiguration, nextLock)
    const desired = desiredPlacements(workspacePath, nextConfiguration, nextLock, resolver)
    const placementPlan = await createPlacementOperations(
      workspaceId,
      desired,
      changeStore.listActivePlacements(workspaceId)
    )
    const internalOperations = [...placementPlan.operations]
    const nextLockContent = serializeWorkspaceSkillLock(nextLock)
    const nextConfigContent = serializeWorkspaceSkillConfiguration(nextConfiguration)
    if (current.lockFile.content !== nextLockContent) {
      internalOperations.push({
        after: { content: nextLockContent, fingerprint: fingerprintContent(nextLockContent) },
        before: current.lockFile,
        kind: 'write_file',
        path: current.lockPath,
        publicKind: 'write_lock',
      })
    }
    if (current.configFile.content !== nextConfigContent) {
      internalOperations.push({
        after: { content: nextConfigContent, fingerprint: fingerprintContent(nextConfigContent) },
        before: current.configFile,
        kind: 'write_file',
        path: current.configPath,
        publicKind: 'write_config',
      })
    }
    if (internalOperations.length === 0) {
      throw new SkillPackChangeError('invalid_intent', 'The requested change has no effect')
    }
    const beforeFingerprint = aggregateSkillPlanFingerprint(
      current.configFile,
      current.lockFile,
      placementPlan.initialStates
    )
    const input: Omit<InternalSkillChangePlan, 'createdAt' | 'expiresAt' | 'id'> = {
      action: intent.action,
      beforeFingerprint,
      intent,
      internalOperations,
      observedFiles: [
        { path: current.configPath, state: current.configFile },
        { path: current.lockPath, state: current.lockFile },
      ],
      observedLinks: Array.from(placementPlan.initialStates, ([path, state]) => ({ path, state })),
      operations: internalOperations.map(publicOperation),
      workspaceId,
    }
    const saved = changeStore.savePlan(input)
    return {
      action: saved.action,
      beforeFingerprint: saved.beforeFingerprint,
      createdAt: saved.createdAt,
      expiresAt: saved.expiresAt,
      id: saved.id,
      intent: saved.intent,
      operations: saved.operations,
      status: 'ready' as const,
      workspaceId: saved.workspaceId,
    }
  }

  return { plan }
}
