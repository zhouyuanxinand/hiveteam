import { isUtf8 } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type {
  AvailableSkill,
  DispatchSkillActivation,
  ResolvedSkillActivation,
  SkillPackManifestSkill,
  SkillPackRelease,
  WorkspaceSkillPackConfiguration,
  WorkspaceSkillPackLock,
  WorkspaceSkillPackLockEntry,
  WorkspaceSkillPackLockSkill,
} from '../shared/skill-packs.js'
import type { AgentSummary } from '../shared/types.js'
import type { DispatchRecord } from './dispatch-ledger-store.js'
import type { DispatchSkillActivationStore } from './dispatch-skill-activation-store.js'
import { isPathWithinRoot } from './fs-sandbox.js'
import type { SkillPlacementRecord } from './skill-pack-change-store.js'
import { readWorkspaceSkillFiles } from './skill-pack-config.js'
import { observeLinkState } from './skill-pack-filesystem.js'
import type { createSkillPackReleaseStore } from './skill-pack-release-store.js'
import type { SkillPackResolver } from './skill-pack-resolver.js'
import { SkillPackResolutionError, sourceUriFor } from './skill-pack-source.js'

const MAX_TEXT_REFERENCE_BYTES = 256 * 1024

export type TeamSkillRuntimeErrorCode =
  | 'ambiguous_skill'
  | 'cache_drift'
  | 'dispatch_not_found'
  | 'invalid_reference_path'
  | 'skill_not_allowed'
  | 'skill_not_found'
  | 'skill_runtime_unavailable'
  | 'unsupported_content'

export class TeamSkillRuntimeError extends Error {
  readonly code: TeamSkillRuntimeErrorCode

  constructor(code: TeamSkillRuntimeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TeamSkillRuntimeError'
    this.code = code
  }
}

interface TeamSkillRuntimeDependencies {
  activationStore: DispatchSkillActivationStore
  getAgent: (workspaceId: string, agentId: string) => AgentSummary
  getDispatch: (workspaceId: string, dispatchId: string) => DispatchRecord | undefined
  getWorkspacePath: (workspaceId: string) => string
  listActivePlacements?: (workspaceId: string) => SkillPlacementRecord[]
  releaseStore: ReturnType<typeof createSkillPackReleaseStore>
  resolver?: SkillPackResolver
}

export interface SkillLaunchReadiness {
  catalog: AvailableSkill[]
  nativeDiscovery: 'prompt_only' | 'ready'
  nativeError: string | null
}

interface ResolvedProfileSkill {
  available: AvailableSkill
  lockPack: WorkspaceSkillPackLockEntry
  lockSkill: WorkspaceSkillPackLockSkill
  manifestSkill: SkillPackManifestSkill
  release: SkillPackRelease
  releasePath: string
}

const digestText = (value: string) =>
  `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`

const resolveAllowedReference = (available: AvailableSkill[], requested: string) => {
  const name = requested.trim()
  const matches = name.includes('/')
    ? available.filter((skill) => skill.qualifiedName === name)
    : available.filter((skill) => skill.name === name)
  if (matches.length === 0) {
    throw new TeamSkillRuntimeError('skill_not_allowed', `Skill is not in this profile: ${name}`)
  }
  if (matches.length > 1) {
    throw new TeamSkillRuntimeError(
      'ambiguous_skill',
      `Skill name is ambiguous; use a qualified name: ${matches
        .map((skill) => skill.qualifiedName)
        .join(', ')}`
    )
  }
  const match = matches[0]
  if (!match) throw new TeamSkillRuntimeError('skill_not_found', `Skill not found: ${name}`)
  return match
}

const assertDispatchOwner = (
  getDispatch: TeamSkillRuntimeDependencies['getDispatch'],
  workspaceId: string,
  agentId: string,
  dispatchId: string
) => {
  const dispatch = getDispatch(workspaceId, dispatchId)
  if (
    !dispatch ||
    dispatch.toAgentId !== agentId ||
    !['queued', 'submitted', 'failed'].includes(dispatch.status)
  ) {
    throw new TeamSkillRuntimeError(
      'dispatch_not_found',
      `No open dispatch is available to this agent: ${dispatchId}`
    )
  }
  return dispatch
}

export const createTeamSkillRuntime = ({
  activationStore,
  getAgent,
  getDispatch,
  getWorkspacePath,
  listActivePlacements,
  releaseStore,
  resolver,
}: TeamSkillRuntimeDependencies) => {
  const expectedCacheFilesystemErrors = new Set([
    'EACCES',
    'EIO',
    'EISDIR',
    'ELOOP',
    'ENOENT',
    'ENOTDIR',
    'EPERM',
  ])
  const requireResolver = () => {
    if (!resolver) {
      throw new TeamSkillRuntimeError(
        'skill_runtime_unavailable',
        'Skill delivery requires a persistent Hive data directory'
      )
    }
    return resolver
  }

  const toCacheDrift = (context: string, error: unknown): never => {
    if (error instanceof TeamSkillRuntimeError) throw error
    const filesystemCode = (error as NodeJS.ErrnoException | undefined)?.code
    if (
      error instanceof SkillPackResolutionError ||
      (filesystemCode !== undefined && expectedCacheFilesystemErrors.has(filesystemCode))
    ) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new TeamSkillRuntimeError('cache_drift', `${context}: ${detail}`, { cause: error })
    }
    throw error
  }

  const readState = async (workspaceId: string) => {
    try {
      return await readWorkspaceSkillFiles(getWorkspacePath(workspaceId))
    } catch (error) {
      return toCacheDrift('Workspace Skill configuration is invalid', error)
    }
  }

  const validateStoredRelease = async (release: SkillPackRelease, packName: string) => {
    const releasePath = requireResolver().getReleasePath(release)
    try {
      const inspection = await requireResolver().inspectRelease(release)
      if (
        inspection.contentDigest !== release.contentDigest ||
        JSON.stringify(inspection.manifest) !== JSON.stringify(release.manifest)
      ) {
        throw new TeamSkillRuntimeError(
          'cache_drift',
          `Immutable release cache has drifted: ${packName}`
        )
      }
      return { releasePath }
    } catch (error) {
      return toCacheDrift(`Locked release is unavailable: ${packName}`, error)
    }
  }

  const assertLockSkillMatchesManifest = (
    reference: string,
    lockSkill: WorkspaceSkillPackLockSkill,
    manifestSkill: SkillPackManifestSkill | undefined
  ): SkillPackManifestSkill => {
    if (
      !manifestSkill ||
      manifestSkill.name !== lockSkill.name ||
      manifestSkill.relativePath !== lockSkill.relativePath ||
      manifestSkill.contentDigest !== lockSkill.contentDigest ||
      manifestSkill.instructionDigest !== lockSkill.instructionDigest ||
      manifestSkill.explicitOnly !== lockSkill.explicitOnly ||
      manifestSkill.containsScripts !== lockSkill.containsScripts
    ) {
      throw new TeamSkillRuntimeError(
        'cache_drift',
        `Locked Skill metadata has drifted: ${reference}`
      )
    }
    return manifestSkill
  }

  const assertLockPackMatchesRelease = (
    lockPack: WorkspaceSkillPackLockEntry,
    release: SkillPackRelease
  ) => {
    const lockNames = new Set(lockPack.skills.map((skill) => skill.name))
    if (
      lockPack.skills.length !== release.manifest.skills.length ||
      lockNames.size !== lockPack.skills.length
    ) {
      throw new TeamSkillRuntimeError(
        'cache_drift',
        `Locked Skill list has drifted: ${lockPack.name}`
      )
    }
    for (const lockSkill of lockPack.skills) {
      assertLockSkillMatchesManifest(
        `${lockPack.name}/${lockSkill.name}`,
        lockSkill,
        release.manifest.skills.find((skill) => skill.name === lockSkill.name)
      )
    }
  }

  const resolveReferences = async (
    configuration: WorkspaceSkillPackConfiguration,
    lock: WorkspaceSkillPackLock,
    references: string[]
  ): Promise<ResolvedProfileSkill[]> => {
    const resolvedReleases = new Map<string, { release: SkillPackRelease; releasePath: string }>()
    const resolvedSkills: ResolvedProfileSkill[] = []
    for (const reference of references) {
      const segments = reference.split('/')
      const packName = segments[0] ?? ''
      const skillName = segments[1] ?? ''
      if (segments.length !== 2 || !packName || !skillName) {
        throw new TeamSkillRuntimeError(
          'cache_drift',
          `Profile contains an invalid qualified Skill name: ${reference}`
        )
      }
      const binding = configuration.packs.find((candidate) => candidate.name === packName)
      const lockPack = lock.packs.find((candidate) => candidate.name === packName)
      if (!binding?.enabled || !lockPack) {
        throw new TeamSkillRuntimeError(
          'cache_drift',
          `Profile references an unlocked or disabled Skill Pack: ${reference}`
        )
      }
      if (
        lockPack.sourceType !== binding.source.type ||
        lockPack.sourceUri !== sourceUriFor(binding.source)
      ) {
        throw new TeamSkillRuntimeError(
          'cache_drift',
          `Skill Pack binding and lock disagree: ${packName}`
        )
      }
      let validated = resolvedReleases.get(packName)
      if (!validated) {
        const release = releaseStore.getById(lockPack.releaseId, packName)
        if (
          !release ||
          release.cacheKey !== lockPack.cacheKey ||
          release.contentDigest !== lockPack.contentDigest ||
          release.resolvedRevision !== lockPack.resolvedRevision ||
          release.source.type !== lockPack.sourceType ||
          release.sourceUri !== lockPack.sourceUri ||
          JSON.stringify(release.source) !== JSON.stringify(binding.source)
        ) {
          throw new TeamSkillRuntimeError(
            'cache_drift',
            `Locked release metadata is unavailable: ${packName}`
          )
        }
        assertLockPackMatchesRelease(lockPack, release)
        validated = { release, ...(await validateStoredRelease(release, packName)) }
        resolvedReleases.set(packName, validated)
      }
      const lockSkill = lockPack.skills.find((candidate) => candidate.name === skillName)
      if (!lockSkill) {
        throw new TeamSkillRuntimeError('cache_drift', `Locked Skill is unavailable: ${reference}`)
      }
      const manifestSkill = assertLockSkillMatchesManifest(
        reference,
        lockSkill,
        validated.release.manifest.skills.find((candidate) => candidate.name === skillName)
      )
      resolvedSkills.push({
        available: {
          description: manifestSkill.description,
          explicitOnly: manifestSkill.explicitOnly,
          name: skillName,
          qualifiedName: reference,
          releaseId: lockPack.releaseId,
        },
        lockPack,
        lockSkill,
        manifestSkill,
        release: validated.release,
        releasePath: validated.releasePath,
      })
    }
    return resolvedSkills.sort((left, right) =>
      left.available.qualifiedName.localeCompare(right.available.qualifiedName)
    )
  }

  const resolveProfile = async (workspaceId: string, agentId: string) => {
    const agent = getAgent(workspaceId, agentId)
    const state = await readState(workspaceId)
    const skills = await resolveReferences(
      state.configuration,
      state.lock,
      state.configuration.profiles[agent.role]
    )
    return { agent, skills, state }
  }

  const listAvailable = async (workspaceId: string, agentId: string) => {
    const profile = await resolveProfile(workspaceId, agentId)
    return profile.skills.map((skill) => skill.available)
  }

  const loadReleaseSkill = async (
    workspaceId: string,
    agentId: string,
    requestedSkill: string
  ): Promise<ResolvedSkillActivation> => {
    const profile = await resolveProfile(workspaceId, agentId)
    const available = profile.skills.map((skill) => skill.available)
    const selected = resolveAllowedReference(available, requestedSkill)
    const resolved = profile.skills.find(
      (skill) => skill.available.qualifiedName === selected.qualifiedName
    )
    if (!resolved)
      throw new TeamSkillRuntimeError('skill_not_found', `Skill not found: ${requestedSkill}`)
    const { lockPack, lockSkill, releasePath } = resolved
    const packName = lockPack.name
    const skillDirectory = resolve(releasePath, lockSkill.relativePath)
    if (!isPathWithinRoot(releasePath, skillDirectory)) {
      throw new TeamSkillRuntimeError(
        'cache_drift',
        `Locked Skill path escapes release: ${requestedSkill}`
      )
    }
    const skillFile = join(skillDirectory, 'SKILL.md')
    const canonicalSkillFile = await realpath(skillFile)
    if (!isPathWithinRoot(skillDirectory, canonicalSkillFile)) {
      throw new TeamSkillRuntimeError(
        'cache_drift',
        `Locked SKILL.md escapes release: ${requestedSkill}`
      )
    }
    const rawInstructionSnapshot = await readFile(canonicalSkillFile, 'utf8')
    if (digestText(rawInstructionSnapshot) !== lockSkill.instructionDigest) {
      throw new TeamSkillRuntimeError(
        'cache_drift',
        `Locked SKILL.md has drifted: ${requestedSkill}`
      )
    }
    // Persist the exact immutable SKILL.md. The dispatch renderer sanitizes
    // control markers at the final prompt boundary without changing evidence.
    const instructionSnapshot = rawInstructionSnapshot
    const payloadDigest = digestText(
      [
        lockPack.releaseId,
        packName,
        lockSkill.name,
        lockSkill.instructionDigest,
        instructionSnapshot,
      ].join('\0')
    )
    return {
      deliveryMode: 'inline',
      instructionSnapshot,
      packName,
      payloadDigest,
      releaseId: lockPack.releaseId,
      skillDigest: lockSkill.contentDigest,
      skillName: lockSkill.name,
    }
  }

  const verifyNativePlacements = async (
    workspaceId: string,
    commandPresetId: string | null,
    state: Awaited<ReturnType<typeof readState>>
  ): Promise<Pick<SkillLaunchReadiness, 'nativeDiscovery' | 'nativeError'>> => {
    if (commandPresetId !== 'codex' || state.configuration.nativeExposure.length === 0) {
      return { nativeDiscovery: 'prompt_only', nativeError: null }
    }
    if (!listActivePlacements) {
      return {
        nativeDiscovery: 'prompt_only',
        nativeError: 'Native placement ledger is unavailable',
      }
    }
    try {
      const expected = await resolveReferences(
        state.configuration,
        state.lock,
        state.configuration.nativeExposure
      )
      const placements = listActivePlacements(workspaceId)
      for (const skill of expected) {
        const placement = placements.find(
          (candidate) =>
            candidate.skillName === skill.available.name &&
            candidate.releaseId === skill.available.releaseId
        )
        const expectedTarget = resolve(skill.releasePath, skill.manifestSkill.relativePath)
        if (!placement || resolve(placement.expectedLinkTarget) !== expectedTarget) {
          return {
            nativeDiscovery: 'prompt_only',
            nativeError: `Native placement is missing: ${skill.available.qualifiedName}`,
          }
        }
        const observed = await observeLinkState(placement.canonicalTargetPath)
        if (
          observed.fingerprint !== placement.afterFingerprint ||
          !observed.target ||
          resolve(observed.target) !== expectedTarget
        ) {
          return {
            nativeDiscovery: 'prompt_only',
            nativeError: `Native placement has drifted: ${skill.available.qualifiedName}`,
          }
        }
      }
      return { nativeDiscovery: 'ready', nativeError: null }
    } catch (error) {
      if (error instanceof TeamSkillRuntimeError) {
        return { nativeDiscovery: 'prompt_only', nativeError: error.message }
      }
      return toCacheDrift('Native Skill placement verification failed', error)
    }
  }

  const assertLaunchReady = async (input: {
    agentId: string
    commandPresetId: string | null
    workspaceId: string
  }): Promise<SkillLaunchReadiness> => {
    const profile = await resolveProfile(input.workspaceId, input.agentId)
    return {
      catalog: profile.skills.map((skill) => skill.available),
      ...(await verifyNativePlacements(input.workspaceId, input.commandPresetId, profile.state)),
    }
  }

  const loadForAgent = async (input: {
    agentId: string
    dispatchId?: string
    skillName?: string
    workspaceId: string
  }): Promise<ResolvedSkillActivation | DispatchSkillActivation> => {
    const agent = getAgent(input.workspaceId, input.agentId)
    if (input.dispatchId) {
      assertDispatchOwner(getDispatch, input.workspaceId, input.agentId, input.dispatchId)
      const activation = activationStore.get(input.dispatchId)
      if (!activation) {
        throw new TeamSkillRuntimeError(
          'skill_not_found',
          `Dispatch has no Skill activation: ${input.dispatchId}`
        )
      }
      return activation
    }
    if (agent.role !== 'orchestrator' || !input.skillName) {
      throw new TeamSkillRuntimeError(
        'skill_not_allowed',
        'Workers may load only the Skill pinned to their own open dispatch'
      )
    }
    return loadReleaseSkill(input.workspaceId, input.agentId, input.skillName)
  }

  const readDispatchReference = async (input: {
    agentId: string
    dispatchId: string
    path: string
    workspaceId: string
  }) => {
    assertDispatchOwner(getDispatch, input.workspaceId, input.agentId, input.dispatchId)
    const activation = activationStore.get(input.dispatchId)
    if (!activation) {
      throw new TeamSkillRuntimeError('skill_not_found', 'Dispatch has no Skill activation')
    }
    const requestedPath = input.path.trim()
    if (
      !requestedPath ||
      isAbsolute(requestedPath) ||
      requestedPath.split(/[\\/]/u).some((segment) => segment === '..')
    ) {
      throw new TeamSkillRuntimeError('invalid_reference_path', 'Reference path must be relative')
    }
    const release = releaseStore.getById(activation.releaseId, activation.packName)
    const manifestSkill = release?.manifest.skills.find(
      (skill) => skill.name === activation.skillName
    )
    if (!release || !manifestSkill) {
      throw new TeamSkillRuntimeError('cache_drift', 'Pinned release is unavailable')
    }
    if (manifestSkill.contentDigest !== activation.skillDigest) {
      throw new TeamSkillRuntimeError('cache_drift', 'Pinned Skill metadata has drifted')
    }
    const { releasePath } = await validateStoredRelease(release, activation.packName)
    const skillPath = resolve(releasePath, manifestSkill.relativePath)
    const requested = resolve(skillPath, requestedPath)
    if (!isPathWithinRoot(skillPath, requested)) {
      throw new TeamSkillRuntimeError('invalid_reference_path', 'Reference path escapes the Skill')
    }
    const packRelativePath = relative(releasePath, requested).split(sep).join('/')
    if (manifestSkill.scriptPaths.includes(packRelativePath)) {
      throw new TeamSkillRuntimeError(
        'unsupported_content',
        'Executable and script files cannot be loaded through team skill read'
      )
    }
    let canonical: string
    try {
      canonical = await realpath(requested)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new TeamSkillRuntimeError('skill_not_found', `Reference not found: ${requestedPath}`)
      }
      return toCacheDrift('Pinned Skill reference is unavailable', error)
    }
    if (!isPathWithinRoot(skillPath, canonical)) {
      throw new TeamSkillRuntimeError('invalid_reference_path', 'Reference path escapes the Skill')
    }
    const fileStats = await stat(canonical)
    if (!fileStats.isFile() || fileStats.size > MAX_TEXT_REFERENCE_BYTES) {
      throw new TeamSkillRuntimeError(
        'unsupported_content',
        `Reference must be a text file no larger than ${MAX_TEXT_REFERENCE_BYTES} bytes`
      )
    }
    const contentBuffer = await readFile(canonical)
    if (!isUtf8(contentBuffer) || contentBuffer.includes(0)) {
      throw new TeamSkillRuntimeError('unsupported_content', 'Binary references are not supported')
    }
    const content = contentBuffer.toString('utf8')
    return { content, path: requestedPath, payloadDigest: digestText(content) }
  }

  return {
    assertLaunchReady,
    getDispatchActivation: activationStore.get,
    listAvailable,
    loadForAgent,
    readDispatchReference,
    resolveDispatchActivation: loadReleaseSkill,
  }
}

export type TeamSkillRuntime = ReturnType<typeof createTeamSkillRuntime>
