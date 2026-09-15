import { createHash } from 'node:crypto'
import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import type {
  EffectiveSkillObservation,
  SkillChangePlan,
  SkillChangeReceipt,
  SkillMemberInspection,
  SkillNameConflict,
  SkillPackChangeIntent,
  SkillRootObservation,
  SkillScanStatus,
  SkillSourceScope,
  WorkspaceSkillInspection,
} from '../shared/skill-packs.js'
import type { AgentSummary } from '../shared/types.js'
import { isPathWithinRoot } from './fs-sandbox.js'
import { parseSkillDirectory } from './skill-file-parser.js'
import { createSkillPackChangeExecutor } from './skill-pack-change-executor.js'
import type { SkillPackChangeStore } from './skill-pack-change-store.js'
import { readWorkspaceSkillFiles } from './skill-pack-config.js'
import { SkillPackChangeError } from './skill-pack-operation-errors.js'
import { createSkillPackPlanner } from './skill-pack-planner.js'
import type { createSkillPackReleaseStore } from './skill-pack-release-store.js'
import type { SkillPackResolver } from './skill-pack-resolver.js'
import { SkillPackResolutionError } from './skill-pack-source.js'
import { resolveSkillRootDescriptors, type SkillRootDescriptor } from './skill-root-adapters.js'
import type { createSkillSnapshotStore } from './skill-snapshot-store.js'
import type { TeamSkillRuntime } from './team-skill-runtime.js'

const MAX_SKILLS_PER_ROOT = 500
const SCOPE_ORDER: Record<SkillSourceScope, number> = { workspace: 0, user: 1, system: 2 }

interface WorkspaceSkillManagerDependencies {
  getCommandPresetId: (workspaceId: string, agentId: string) => string | null
  getActiveRunStartedAt?: (workspaceId: string, agentId: string) => number | null
  getWorkspace: (workspaceId: string) => {
    agents: AgentSummary[]
    summary: { path: string }
  }
  homePath?: string
  changeStore: SkillPackChangeStore
  packResolver?: SkillPackResolver
  releaseStore: ReturnType<typeof createSkillPackReleaseStore>
  snapshotStore: ReturnType<typeof createSkillSnapshotStore>
  teamSkillRuntime: TeamSkillRuntime
}

interface ScannedRoot {
  observation: SkillRootObservation
  skills: EffectiveSkillObservation[]
}

const pathKey = (value: string) =>
  process.platform === 'win32' ? resolve(value).toLocaleLowerCase('en-US') : resolve(value)

const errorDetail = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  const message = error instanceof Error ? error.message : String(error)
  return code ? `${code}: ${message}` : message
}

const missingPath = (error: unknown) =>
  (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'

const scanRoot = async (
  descriptor: SkillRootDescriptor,
  allowedRoots: string[]
): Promise<ScannedRoot> => {
  const observation: SkillRootObservation = {
    ...descriptor,
    error: null,
    status: 'missing',
  }
  try {
    const canonicalRoot = await realpath(descriptor.path)
    if (!allowedRoots.some((root) => isPathWithinRoot(root, canonicalRoot))) {
      return {
        observation: {
          ...observation,
          error: 'skill_root_outside_allowed_roots',
          status: 'unreadable',
        },
        skills: [],
      }
    }
    const rootStats = await stat(canonicalRoot)
    if (!rootStats.isDirectory()) {
      return {
        observation: {
          ...observation,
          error: 'skill_root_not_directory',
          status: 'unreadable',
        },
        skills: [],
      }
    }
    const entries = (await readdir(canonicalRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .sort((left, right) => left.name.localeCompare(right.name))
    const limitedEntries = entries.slice(0, MAX_SKILLS_PER_ROOT)
    const skills = await Promise.all(
      limitedEntries.map((entry) =>
        parseSkillDirectory({
          allowedRoots,
          directoryName: entry.name,
          rootId: descriptor.id,
          scope: descriptor.scope,
          skillPath: join(canonicalRoot, entry.name),
        })
      )
    )
    return {
      observation: {
        ...observation,
        error: entries.length > MAX_SKILLS_PER_ROOT ? 'skill_count_limit_exceeded' : null,
        status: 'found',
      },
      skills,
    }
  } catch (error) {
    if (missingPath(error)) return { observation, skills: [] }
    return {
      observation: { ...observation, error: errorDetail(error), status: 'unreadable' },
      skills: [],
    }
  }
}

const mergeObservedSkills = (roots: ScannedRoot[]): EffectiveSkillObservation[] => {
  const byCanonicalPath = new Map<string, EffectiveSkillObservation>()
  for (const skill of roots.flatMap((root) => root.skills)) {
    const key = pathKey(skill.canonicalPath)
    const current = byCanonicalPath.get(key)
    if (!current) {
      byCanonicalPath.set(key, { ...skill })
      continue
    }
    current.rootIds = Array.from(new Set([...current.rootIds, ...skill.rootIds]))
    current.sourceScopes = Array.from(
      new Set([...current.sourceScopes, ...skill.sourceScopes])
    ).sort((left, right) => SCOPE_ORDER[left] - SCOPE_ORDER[right])
    current.validationErrors = Array.from(
      new Set([...current.validationErrors, ...skill.validationErrors])
    )
  }

  const skills = Array.from(byCanonicalPath.values())
  const pathsByName = new Map<string, Set<string>>()
  for (const skill of skills) {
    const paths = pathsByName.get(skill.name) ?? new Set<string>()
    paths.add(pathKey(skill.canonicalPath))
    pathsByName.set(skill.name, paths)
  }
  for (const skill of skills) {
    skill.conflict = (pathsByName.get(skill.name)?.size ?? 0) > 1
  }
  return skills.sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.canonicalPath.localeCompare(right.canonicalPath)
  )
}

const scanStatusFor = (
  roots: SkillRootObservation[],
  skills: EffectiveSkillObservation[]
): SkillScanStatus => {
  const unreadableCount = roots.filter((root) => root.status === 'unreadable').length
  const foundCount = roots.filter((root) => root.status === 'found').length
  const invalidCount = skills.filter((skill) => skill.validationErrors.length > 0).length
  if (foundCount === 0 && unreadableCount > 0) return 'failed'
  if (unreadableCount > 0 || invalidCount > 0) return 'partial'
  if (skills.length === 0) return 'empty'
  return 'ready'
}

const inspectMember = async (input: {
  agent: AgentSummary
  commandPresetId: string | null
  deliveryError: string | null
  homePath: string
  managedNativeDiscovery: 'prompt_only' | 'ready' | null
  nativeError: string | null
  profileConfigured: boolean
  restartRequired: boolean
  workspacePath: string
}): Promise<SkillMemberInspection> => {
  const descriptors = resolveSkillRootDescriptors({
    homePath: input.homePath,
    presetId: input.commandPresetId,
    workspacePath: input.workspacePath,
  })
  const allowedRoots = [
    input.workspacePath,
    input.homePath,
    ...descriptors.map((descriptor) => descriptor.path),
  ]
  const roots = await Promise.all(
    descriptors.map((descriptor) => scanRoot(descriptor, allowedRoots))
  )
  const observations = roots.map((root) => root.observation)
  const skills = mergeObservedSkills(roots)
  const scanStatus = scanStatusFor(observations, skills)
  const hasConflict = skills.some((skill) => skill.conflict)
  const hasVerifiedAdapter = descriptors.some((root) => root.verified)
  const validSkillCount = skills.filter((skill) => skill.validationErrors.length === 0).length
  const rootErrors = observations
    .filter((root) => root.error)
    .map((root) => `${root.label}: ${root.error}`)
  const errors = Array.from(
    new Set([...rootErrors, input.deliveryError, input.nativeError].filter(Boolean))
  )

  return {
    agentId: input.agent.id,
    commandPresetId: input.commandPresetId,
    deliveryStatus: input.deliveryError
      ? 'failed'
      : input.profileConfigured
        ? 'ready'
        : 'not_configured',
    error: errors.length > 0 ? errors.join('\n') : null,
    name: input.agent.name,
    nativeDiscoveryStatus: hasConflict
      ? 'conflict'
      : input.restartRequired
        ? 'restart_required'
        : input.managedNativeDiscovery
          ? input.managedNativeDiscovery
          : !hasVerifiedAdapter
            ? 'unverified'
            : validSkillCount > 0
              ? 'ready'
              : 'prompt_only',
    profile: input.agent.role,
    restartRequired: input.restartRequired,
    roots: observations,
    scanStatus,
    skills,
    status: input.agent.status,
  }
}

const collectConflicts = (members: SkillMemberInspection[]): SkillNameConflict[] => {
  const byName = new Map<string, { memberIds: Set<string>; paths: Set<string> }>()
  for (const member of members) {
    for (const skill of member.skills.filter((candidate) => candidate.conflict)) {
      const conflict = byName.get(skill.name) ?? { memberIds: new Set(), paths: new Set() }
      conflict.memberIds.add(member.agentId)
      conflict.paths.add(skill.canonicalPath)
      byName.set(skill.name, conflict)
    }
  }
  return Array.from(byName, ([name, conflict]) => ({
    memberIds: Array.from(conflict.memberIds).sort(),
    name,
    paths: Array.from(conflict.paths).sort(),
  })).sort((left, right) => left.name.localeCompare(right.name))
}

const fingerprintMember = (member: SkillMemberInspection) =>
  `sha256:${createHash('sha256').update(JSON.stringify(member)).digest('hex')}`

export interface WorkspaceSkillManager {
  applyPlan: (workspaceId: string, planId: string) => Promise<SkillChangeReceipt>
  inspect: (workspaceId: string) => Promise<WorkspaceSkillInspection>
  getDispatchActivation: TeamSkillRuntime['getDispatchActivation']
  listForAgent: TeamSkillRuntime['listAvailable']
  loadForAgent: TeamSkillRuntime['loadForAgent']
  plan: (workspaceId: string, intent: SkillPackChangeIntent) => Promise<SkillChangePlan>
  resolvePack: SkillPackResolver['resolve']
  scan: (workspaceId: string) => Promise<WorkspaceSkillInspection>
  readDispatchReference: TeamSkillRuntime['readDispatchReference']
  undoReceipt: (workspaceId: string, receiptId: string) => Promise<SkillChangeReceipt>
}

export const createWorkspaceSkillManager = ({
  getCommandPresetId,
  getActiveRunStartedAt,
  getWorkspace,
  homePath = homedir(),
  changeStore,
  packResolver,
  releaseStore,
  snapshotStore,
  teamSkillRuntime,
}: WorkspaceSkillManagerDependencies): WorkspaceSkillManager => {
  const planner = packResolver
    ? createSkillPackPlanner({
        changeStore,
        getWorkspacePath: (workspaceId) => getWorkspace(workspaceId).summary.path,
        releaseStore,
        resolver: packResolver,
      })
    : null
  const executor = createSkillPackChangeExecutor({
    changeStore,
    getWorkspacePath: (workspaceId) => getWorkspace(workspaceId).summary.path,
  })
  const recovery = executor.recover()

  const scan = async (workspaceId: string): Promise<WorkspaceSkillInspection> => {
    await recovery
    const workspace = getWorkspace(workspaceId)
    const workspacePath = resolve(workspace.summary.path)
    const portable = await readWorkspaceSkillFiles(workspacePath)
    const receipts = changeStore.listReceipts(workspaceId)
    const latestNativeChangeAt = receipts
      .filter(
        (receipt) =>
          receipt.completedAt !== null &&
          receipt.error === null &&
          (receipt.state === 'applied' || receipt.state === 'rolled_back') &&
          receipt.operations.some(
            (operation) =>
              operation.kind === 'create_placement' || operation.kind === 'remove_placement'
          )
      )
      .reduce((latest, receipt) => Math.max(latest, receipt.completedAt ?? 0), 0)
    const members = await Promise.all(
      [...workspace.agents]
        .sort((left, right) => {
          if (left.role === 'orchestrator') return -1
          if (right.role === 'orchestrator') return 1
          return left.name.localeCompare(right.name)
        })
        .map(async (agent) => {
          const commandPresetId = getCommandPresetId(workspaceId, agent.id)
          let deliveryError: string | null = null
          let managedNativeDiscovery: 'prompt_only' | 'ready' | null = null
          let nativeError: string | null = null
          try {
            const readiness = await teamSkillRuntime.assertLaunchReady({
              agentId: agent.id,
              commandPresetId,
              workspaceId,
            })
            if (portable.configuration.nativeExposure.length > 0 && commandPresetId === 'codex') {
              managedNativeDiscovery = readiness.nativeDiscovery
              nativeError = readiness.nativeError
            }
          } catch (error) {
            deliveryError = errorDetail(error)
          }
          return inspectMember({
            agent,
            commandPresetId,
            deliveryError,
            homePath: resolve(homePath),
            managedNativeDiscovery,
            nativeError,
            profileConfigured: portable.configuration.profiles[agent.role].length > 0,
            restartRequired:
              commandPresetId === 'codex' &&
              latestNativeChangeAt >=
                (getActiveRunStartedAt?.(workspaceId, agent.id) ?? Number.POSITIVE_INFINITY),
            workspacePath,
          })
        })
    )
    const conflicts = collectConflicts(members)
    const uniqueSkills = new Map<string, EffectiveSkillObservation>()
    for (const skill of members.flatMap((member) => member.skills)) {
      uniqueSkills.set(pathKey(skill.canonicalPath), skill)
    }
    snapshotStore.insertWorkspaceSnapshots(
      workspaceId,
      members.map((member) => ({ fingerprint: fingerprintMember(member), member }))
    )
    return {
      conflicts,
      configuration: portable.configuration,
      lock: portable.lock,
      members,
      plans: changeStore.listPlans(workspaceId),
      receipts,
      scannedAt: Date.now(),
      summary: {
        conflictCount: conflicts.length,
        effectiveSkillCount: uniqueSkills.size,
        invalidSkillCount: Array.from(uniqueSkills.values()).filter(
          (skill) => skill.validationErrors.length > 0
        ).length,
        memberCount: members.length,
      },
      workspaceId,
    }
  }

  return {
    applyPlan: async (workspaceId, planId) => {
      await recovery
      return executor.apply(workspaceId, planId)
    },
    getDispatchActivation: teamSkillRuntime.getDispatchActivation,
    inspect: scan,
    listForAgent: teamSkillRuntime.listAvailable,
    loadForAgent: teamSkillRuntime.loadForAgent,
    plan: async (workspaceId, intent) => {
      await recovery
      if (!planner) {
        throw new SkillPackChangeError(
          'release_unavailable',
          'Skill Pack changes require a persistent Hive data directory'
        )
      }
      return planner.plan(workspaceId, intent)
    },
    resolvePack: (input, options) => {
      if (!packResolver) {
        throw new SkillPackResolutionError(
          'cache_unavailable',
          'Skill Pack resolution requires a persistent Hive data directory'
        )
      }
      return packResolver.resolve(input, options)
    },
    readDispatchReference: teamSkillRuntime.readDispatchReference,
    scan,
    undoReceipt: async (workspaceId, receiptId) => {
      await recovery
      return executor.undo(workspaceId, receiptId)
    },
  }
}
