import { isUtf8 } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

import matter from 'gray-matter'

import type { EffectiveSkillObservation, SkillSourceScope } from '../shared/skill-packs.js'
import { isPathWithinRoot } from './fs-sandbox.js'
import { isSkillScriptOrExecutable } from './skill-file-classification.js'

const MAX_SKILL_MD_BYTES = 256 * 1024
const MAX_INVENTORY_ENTRIES = 512
const MAX_INVENTORY_DEPTH = 4
const VALID_SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u
const EXPECTED_SKILL_IO_ERRORS = new Set([
  'EACCES',
  'EISDIR',
  'ELOOP',
  'ENOENT',
  'ENOTDIR',
  'EPERM',
])

class SkillObservationError extends Error {
  readonly observationCode: string

  constructor(observationCode: string, options?: ErrorOptions) {
    super(observationCode, options)
    this.name = 'SkillObservationError'
    this.observationCode = observationCode
  }
}

export interface ParsedSkillMarkdown {
  description: string | null
  explicitOnly: boolean
  name: string
  validationErrors: string[]
}

export interface SkillDirectoryParseInput {
  allowedRoots: string[]
  directoryName: string
  rootId: string
  scope: SkillSourceScope
  skillPath: string
}

const readBoolean = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)

export const parseSkillMarkdown = (raw: string, directoryName: string): ParsedSkillMarkdown => {
  let parsed: ReturnType<typeof matter>
  try {
    parsed = matter(raw)
  } catch (error) {
    throw new SkillObservationError('invalid_frontmatter', { cause: error })
  }
  const declaredName = typeof parsed.data.name === 'string' ? parsed.data.name.trim() : ''
  const description =
    typeof parsed.data.description === 'string' && parsed.data.description.trim()
      ? parsed.data.description.trim()
      : null
  const name = declaredName || directoryName
  const validationErrors: string[] = []
  if (!declaredName) validationErrors.push('missing_name')
  if (!VALID_SKILL_NAME.test(name)) validationErrors.push('invalid_name')
  if (!description) validationErrors.push('missing_description')
  if (description && description.length > 1_024) validationErrors.push('description_too_long')

  const disableModelInvocation =
    readBoolean(parsed.data['disable-model-invocation']) ??
    readBoolean(parsed.data.disable_model_invocation) ??
    false
  const autoInvoke = readBoolean(parsed.data.autoinvoke)

  return {
    description,
    explicitOnly: disableModelInvocation || autoInvoke === false,
    name,
    validationErrors,
  }
}

const inventoryContainsScripts = async (skillPath: string): Promise<boolean> => {
  let visited = 0
  const pending: Array<{ depth: number; path: string }> = [{ depth: 0, path: skillPath }]
  while (pending.length > 0 && visited < MAX_INVENTORY_ENTRIES) {
    const current = pending.pop()
    if (!current) break
    const entries = await readdir(current.path, { withFileTypes: true })
    for (const entry of entries) {
      visited += 1
      if (entry.name.toLocaleLowerCase('en-US') === 'scripts' && entry.isDirectory()) return true
      const entryPath = join(current.path, entry.name)
      if (entry.isFile()) {
        const entryStats = await stat(entryPath)
        if (
          isSkillScriptOrExecutable(
            relative(skillPath, entryPath).replaceAll('\\', '/'),
            entryStats.mode
          )
        ) {
          return true
        }
      }
      if (entry.isDirectory() && current.depth < MAX_INVENTORY_DEPTH) {
        pending.push({ depth: current.depth + 1, path: entryPath })
      }
      if (visited >= MAX_INVENTORY_ENTRIES) break
    }
  }
  return false
}

const canonicalizeWithinAllowedRoots = async (path: string, allowedRoots: string[]) => {
  const canonicalPath = await realpath(path)
  if (!allowedRoots.some((root) => isPathWithinRoot(root, canonicalPath))) {
    throw new SkillObservationError('skill_path_outside_allowed_roots')
  }
  return canonicalPath
}

const expectedObservationCode = (error: unknown) => {
  if (error instanceof SkillObservationError) return error.observationCode
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code && EXPECTED_SKILL_IO_ERRORS.has(code) ? `skill_io_${code.toLowerCase()}` : null
}

export const parseSkillDirectory = async ({
  allowedRoots,
  directoryName,
  rootId,
  scope,
  skillPath,
}: SkillDirectoryParseInput): Promise<EffectiveSkillObservation> => {
  const fallbackPath = resolve(skillPath)
  try {
    const canonicalPath = await canonicalizeWithinAllowedRoots(skillPath, allowedRoots)
    const skillStats = await stat(canonicalPath)
    if (!skillStats.isDirectory()) throw new SkillObservationError('skill_path_not_directory')
    const instructionPath = join(canonicalPath, 'SKILL.md')
    const canonicalInstructionPath = await canonicalizeWithinAllowedRoots(instructionPath, [
      canonicalPath,
    ])
    const instructionStats = await stat(canonicalInstructionPath)
    if (!instructionStats.isFile()) throw new SkillObservationError('skill_file_not_regular')
    if (instructionStats.size > MAX_SKILL_MD_BYTES) {
      throw new SkillObservationError('skill_file_too_large')
    }
    const rawBuffer = await readFile(canonicalInstructionPath)
    if (!isUtf8(rawBuffer) || rawBuffer.includes(0)) {
      throw new SkillObservationError('skill_file_not_text')
    }
    const raw = rawBuffer.toString('utf8')
    const metadata = parseSkillMarkdown(raw, directoryName)
    return {
      canonicalPath,
      conflict: false,
      containsScripts: await inventoryContainsScripts(canonicalPath),
      description: metadata.description,
      directoryName,
      explicitOnly: metadata.explicitOnly,
      instructionDigest: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
      name: metadata.name,
      rootIds: [rootId],
      sourceScopes: [scope],
      validationErrors: metadata.validationErrors,
    }
  } catch (error) {
    const code = expectedObservationCode(error)
    if (!code) throw error
    return {
      canonicalPath: fallbackPath,
      conflict: false,
      containsScripts: false,
      description: null,
      directoryName,
      explicitOnly: false,
      instructionDigest: '',
      name: directoryName,
      rootIds: [rootId],
      sourceScopes: [scope],
      validationErrors: [code],
    }
  }
}
