import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describeSkillPackSource } from '../shared/skill-pack-source.js'
import type {
  SkillPackSource,
  SkillProfiles,
  WorkspaceSkillPackConfiguration,
  WorkspaceSkillPackLock,
  WorkspaceSkillPackLockEntry,
} from '../shared/skill-packs.js'
import { skillProfileNames } from '../shared/skill-packs.js'
import type { SkillFileState } from './skill-pack-change-types.js'
import {
  normalizeResolveSkillPackInput,
  normalizeSkillPackName,
  SkillPackResolutionError,
} from './skill-pack-source.js'

const MAX_PORTABLE_FILE_BYTES = 1024 * 1024
const skillProfileNameSet = new Set<string>(skillProfileNames)

export const emptySkillProfiles = (): SkillProfiles => ({
  coder: [],
  custom: [],
  orchestrator: [],
  reviewer: [],
  tester: [],
})

export const emptyWorkspaceSkillConfiguration = (): WorkspaceSkillPackConfiguration => ({
  nativeExposure: [],
  packs: [],
  profiles: emptySkillProfiles(),
  version: 1,
})

export const emptyWorkspaceSkillLock = (): WorkspaceSkillPackLock => ({ packs: [], version: 1 })

export const fingerprintContent = (content: string | null) =>
  content === null
    ? 'missing'
    : `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`

const readFileState = async (path: string): Promise<SkillFileState> => {
  try {
    const content = await readFile(path, 'utf8')
    if (Buffer.byteLength(content, 'utf8') > MAX_PORTABLE_FILE_BYTES) {
      throw new SkillPackResolutionError(
        'limit_exceeded',
        `Skill Pack configuration exceeds ${MAX_PORTABLE_FILE_BYTES} bytes: ${path}`
      )
    }
    return { content, fingerprint: fingerprintContent(content) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { content: null, fingerprint: 'missing' }
    }
    throw error
  }
}

const objectValue = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SkillPackResolutionError('invalid_source', `${label} must be an object`)
  }
  return value as Record<string, unknown>
}

const stringValue = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SkillPackResolutionError('invalid_source', `${label} must be a non-empty string`)
  }
  return value
}

const stringList = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new SkillPackResolutionError('invalid_source', `${label} must be a string array`)
  }
  return Array.from(new Set(value.map((entry) => entry.trim()).filter(Boolean))).sort()
}

const parseSource = (value: unknown, packName: string): SkillPackSource => {
  const source = objectValue(value, `packs.${packName}.source`)
  const type = stringValue(source.type, `packs.${packName}.source.type`)
  if (type === 'github') {
    return normalizeResolveSkillPackInput({
      packName,
      source: {
        ref: stringValue(source.ref, `packs.${packName}.source.ref`),
        repository: stringValue(source.repository, `packs.${packName}.source.repository`),
        type,
      },
    }).source
  }
  if (type === 'git') {
    return normalizeResolveSkillPackInput({
      packName,
      source: {
        ref: stringValue(source.ref, `packs.${packName}.source.ref`),
        type,
        url: stringValue(source.url, `packs.${packName}.source.url`),
      },
    }).source
  }
  if (type === 'local') {
    return normalizeResolveSkillPackInput({
      packName,
      source: { path: stringValue(source.path, `packs.${packName}.source.path`), type },
    }).source
  }
  throw new SkillPackResolutionError('invalid_source', `Unsupported source type: ${type}`)
}

export const parseWorkspaceSkillConfiguration = (
  content: string | null
): WorkspaceSkillPackConfiguration => {
  if (content === null) return emptyWorkspaceSkillConfiguration()
  let raw: Record<string, unknown>
  try {
    raw = objectValue(JSON.parse(content) as unknown, 'Skill Pack configuration')
  } catch (error) {
    if (error instanceof SkillPackResolutionError) throw error
    throw new SkillPackResolutionError(
      'invalid_source',
      `Invalid .hive/skill-packs.json: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (raw.version !== 1) {
    throw new SkillPackResolutionError(
      'invalid_source',
      'Unsupported .hive/skill-packs.json version'
    )
  }
  if (!Array.isArray(raw.packs)) {
    throw new SkillPackResolutionError('invalid_source', 'packs must be an array')
  }
  const seenNames = new Set<string>()
  const packs = raw.packs.map((entry, index) => {
    const pack = objectValue(entry, `packs[${index}]`)
    const name = normalizeSkillPackName(stringValue(pack.name, `packs[${index}].name`))
    if (seenNames.has(name)) {
      throw new SkillPackResolutionError('duplicate_skill_name', `Duplicate Pack name: ${name}`)
    }
    seenNames.add(name)
    if (typeof pack.enabled !== 'boolean') {
      throw new SkillPackResolutionError(
        'invalid_source',
        `packs[${index}].enabled must be boolean`
      )
    }
    return { enabled: pack.enabled, name, source: parseSource(pack.source, name) }
  })
  const rawProfiles = objectValue(raw.profiles, 'profiles')
  const unknownProfiles = Object.keys(rawProfiles).filter(
    (profile) => !skillProfileNameSet.has(profile)
  )
  if (unknownProfiles.length > 0) {
    throw new SkillPackResolutionError(
      'invalid_source',
      `Unknown profiles: ${unknownProfiles.join(', ')}`
    )
  }
  const profiles = emptySkillProfiles()
  for (const profile of skillProfileNames) {
    profiles[profile] = stringList(rawProfiles[profile] ?? [], `profiles.${profile}`)
  }
  return {
    nativeExposure: stringList(raw.native_exposure ?? [], 'native_exposure'),
    packs: packs.sort((left, right) => left.name.localeCompare(right.name)),
    profiles,
    version: 1,
  }
}

const parseLockEntry = (value: unknown, index: number): WorkspaceSkillPackLockEntry => {
  const entry = objectValue(value, `lock.packs[${index}]`)
  const sourceType = stringValue(entry.source_type, `lock.packs[${index}].source_type`)
  if (!['github', 'git', 'local'].includes(sourceType)) {
    throw new SkillPackResolutionError('invalid_source', `Invalid source type: ${sourceType}`)
  }
  if (!Array.isArray(entry.skills)) {
    throw new SkillPackResolutionError(
      'invalid_source',
      `lock.packs[${index}].skills must be an array`
    )
  }
  return {
    cacheKey: stringValue(entry.cache_key, `lock.packs[${index}].cache_key`),
    contentDigest: stringValue(entry.content_digest, `lock.packs[${index}].content_digest`),
    name: stringValue(entry.name, `lock.packs[${index}].name`),
    releaseId: stringValue(entry.release_id, `lock.packs[${index}].release_id`),
    resolvedRevision: stringValue(
      entry.resolved_revision,
      `lock.packs[${index}].resolved_revision`
    ),
    skills: entry.skills.map((rawSkill, skillIndex) => {
      const skill = objectValue(rawSkill, `lock.packs[${index}].skills[${skillIndex}]`)
      if (typeof skill.contains_scripts !== 'boolean' || typeof skill.explicit_only !== 'boolean') {
        throw new SkillPackResolutionError(
          'invalid_source',
          `lock.packs[${index}].skills[${skillIndex}] has invalid booleans`
        )
      }
      return {
        containsScripts: skill.contains_scripts,
        contentDigest: stringValue(skill.content_digest, 'skill.content_digest'),
        explicitOnly: skill.explicit_only,
        instructionDigest: stringValue(skill.instruction_digest, 'skill.instruction_digest'),
        name: stringValue(skill.name, 'skill.name'),
        relativePath: stringValue(skill.relative_path, 'skill.relative_path'),
      }
    }),
    sourceType: sourceType as WorkspaceSkillPackLockEntry['sourceType'],
    sourceUri: stringValue(entry.source_uri, `lock.packs[${index}].source_uri`),
  }
}

export const parseWorkspaceSkillLock = (content: string | null): WorkspaceSkillPackLock => {
  if (content === null) return emptyWorkspaceSkillLock()
  let raw: Record<string, unknown>
  try {
    raw = objectValue(JSON.parse(content) as unknown, 'Skill Pack lock')
  } catch (error) {
    if (error instanceof SkillPackResolutionError) throw error
    throw new SkillPackResolutionError(
      'invalid_source',
      `Invalid .hive/skill-packs.lock.json: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (raw.version !== 1 || !Array.isArray(raw.packs)) {
    throw new SkillPackResolutionError('invalid_source', 'Unsupported Skill Pack lock format')
  }
  const packs = raw.packs.map(parseLockEntry)
  if (new Set(packs.map((pack) => pack.name)).size !== packs.length) {
    throw new SkillPackResolutionError('invalid_source', 'Duplicate Pack name in lock')
  }
  return { packs: packs.sort((left, right) => left.name.localeCompare(right.name)), version: 1 }
}

export const serializeWorkspaceSkillConfiguration = (
  configuration: WorkspaceSkillPackConfiguration
) =>
  `${JSON.stringify(
    {
      native_exposure: configuration.nativeExposure,
      packs: configuration.packs.map((pack) => ({
        enabled: pack.enabled,
        name: pack.name,
        source: describeSkillPackSource(pack.source).payload,
      })),
      profiles: configuration.profiles,
      version: configuration.version,
    },
    null,
    2
  )}\n`

export const serializeWorkspaceSkillLock = (lock: WorkspaceSkillPackLock) =>
  `${JSON.stringify(
    {
      packs: lock.packs.map((pack) => ({
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
      version: lock.version,
    },
    null,
    2
  )}\n`

export const readWorkspaceSkillFiles = async (workspacePath: string) => {
  const configPath = join(workspacePath, '.hive', 'skill-packs.json')
  const lockPath = join(workspacePath, '.hive', 'skill-packs.lock.json')
  const [configFile, lockFile] = await Promise.all([
    readFileState(configPath),
    readFileState(lockPath),
  ])
  return {
    configFile,
    configPath,
    configuration: parseWorkspaceSkillConfiguration(configFile.content),
    lock: parseWorkspaceSkillLock(lockFile.content),
    lockFile,
    lockPath,
  }
}
