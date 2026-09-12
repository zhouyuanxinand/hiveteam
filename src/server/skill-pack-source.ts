import { isAbsolute, resolve } from 'node:path'
import { describeSkillPackSource } from '../shared/skill-pack-source.js'
import type { ResolveSkillPackInput, SkillPackSource } from '../shared/skill-packs.js'

export type SkillPackResolutionErrorCode =
  | 'cache_unavailable'
  | 'duplicate_skill_name'
  | 'git_failed'
  | 'invalid_pack_name'
  | 'invalid_skill'
  | 'invalid_source'
  | 'limit_exceeded'
  | 'source_not_found'
  | 'source_path_unsafe'

export class SkillPackResolutionError extends Error {
  readonly code: SkillPackResolutionErrorCode

  constructor(code: SkillPackResolutionErrorCode, message: string) {
    super(message)
    this.name = 'SkillPackResolutionError'
    this.code = code
  }
}

const VALID_PACK_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u
const VALID_GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u
const VALID_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u

export const normalizeSkillPackName = (value: string) => {
  const packName = value.trim()
  if (!VALID_PACK_NAME.test(packName)) {
    throw new SkillPackResolutionError(
      'invalid_pack_name',
      'Pack name must use 1-64 lowercase letters, numbers, or hyphens'
    )
  }
  return packName
}

const normalizeRef = (value: string) => {
  const ref = value.trim()
  if (
    !VALID_REF.test(ref) ||
    ref.includes('..') ||
    ref.includes('@{') ||
    ref.includes('//') ||
    ref.endsWith('/') ||
    ref.endsWith('.lock')
  ) {
    throw new SkillPackResolutionError('invalid_source', `Invalid Git ref: ${value}`)
  }
  return ref
}

const normalizeHttpsGitUrl = (value: string) => {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new SkillPackResolutionError('invalid_source', 'Git source must be a valid HTTPS URL')
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !parsed.hostname
  ) {
    throw new SkillPackResolutionError(
      'invalid_source',
      'Git source must be a credential-free HTTPS URL without query or fragment'
    )
  }
  return parsed.toString()
}

export const normalizeResolveSkillPackInput = (
  input: ResolveSkillPackInput
): ResolveSkillPackInput => {
  const packName = normalizeSkillPackName(input.packName)

  let source: SkillPackSource
  if (input.source.type === 'github') {
    const repository = input.source.repository.trim().replace(/\.git$/u, '')
    if (!VALID_GITHUB_REPOSITORY.test(repository)) {
      throw new SkillPackResolutionError(
        'invalid_source',
        'GitHub repository must use the owner/repository form'
      )
    }
    source = { ref: normalizeRef(input.source.ref), repository, type: 'github' }
  } else if (input.source.type === 'git') {
    source = {
      ref: normalizeRef(input.source.ref),
      type: 'git',
      url: normalizeHttpsGitUrl(input.source.url.trim()),
    }
  } else {
    const rawPath = input.source.path.trim()
    if (!rawPath || !isAbsolute(rawPath)) {
      throw new SkillPackResolutionError(
        'invalid_source',
        'Local Skill Pack source must be an absolute path'
      )
    }
    source = { path: resolve(rawPath), type: 'local' }
  }
  return { packName, source }
}

export const sourceUriFor = (source: SkillPackSource): string => {
  return describeSkillPackSource(source).uri
}
