import { isUtf8 } from 'node:buffer'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import type { SkillPackManifest, SkillPackManifestSkill } from '../shared/skill-packs.js'
import { isPathWithinRoot } from './fs-sandbox.js'
import { isSkillScriptOrExecutable } from './skill-file-classification.js'
import { parseSkillMarkdown } from './skill-file-parser.js'
import { SkillPackResolutionError } from './skill-pack-source.js'

const MAX_FILES = 5_000
const MAX_TOTAL_BYTES = 50 * 1024 * 1024
const MAX_PATH_DEPTH = 24
const MAX_SKILL_MD_BYTES = 256 * 1024
interface InventoriedFile {
  absolutePath: string
  digest: string
  mode: number
  relativePath: string
  size: number
}

export interface InspectedSkillPackTree {
  contentDigest: string
  manifest: SkillPackManifest
}

export interface InspectSkillPackTreeOptions {
  executablePaths?: ReadonlySet<string>
}

const digestFile = async (path: string) => {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

const executableMode = (file: InventoriedFile, options: InspectSkillPackTreeOptions) =>
  options.executablePaths === undefined
    ? file.mode & 0o111
    : options.executablePaths.has(file.relativePath)
      ? 0o111
      : 0

const digestInventory = (files: InventoriedFile[], options: InspectSkillPackTreeOptions) => {
  const digest = createHash('sha256')
  for (const file of files) {
    digest.update(file.relativePath)
    digest.update('\0')
    digest.update(String(file.size))
    digest.update('\0')
    digest.update(String(executableMode(file, options)))
    digest.update('\0')
    digest.update(file.digest)
    digest.update('\0')
  }
  return `sha256:${digest.digest('hex')}`
}

const inventoryTree = async (rootPath: string): Promise<InventoriedFile[]> => {
  const canonicalRoot = await realpath(rootPath)
  const rootStats = await stat(canonicalRoot)
  if (!rootStats.isDirectory()) {
    throw new SkillPackResolutionError('invalid_source', 'Skill Pack source is not a directory')
  }
  const files: InventoriedFile[] = []
  let totalBytes = 0
  const pending: Array<{ absolutePath: string; depth: number; relativePath: string }> = [
    { absolutePath: canonicalRoot, depth: 0, relativePath: '' },
  ]

  while (pending.length > 0) {
    const current = pending.pop()
    if (!current) break
    const entries = (await readdir(current.absolutePath, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name)
    )
    for (const entry of entries) {
      if (current.depth === 0 && entry.name === '.git') continue
      const relativePath = current.relativePath
        ? `${current.relativePath}/${entry.name}`
        : entry.name
      const absolutePath = join(current.absolutePath, entry.name)
      const entryStats = await lstat(absolutePath)
      if (entryStats.isSymbolicLink()) {
        throw new SkillPackResolutionError(
          'source_path_unsafe',
          `Skill Pack sources may not contain symbolic links: ${relativePath}`
        )
      }
      if (entryStats.isDirectory()) {
        if (current.depth + 1 > MAX_PATH_DEPTH) {
          throw new SkillPackResolutionError(
            'limit_exceeded',
            `Skill Pack path depth exceeds ${MAX_PATH_DEPTH}: ${relativePath}`
          )
        }
        pending.push({ absolutePath, depth: current.depth + 1, relativePath })
        continue
      }
      if (!entryStats.isFile()) {
        throw new SkillPackResolutionError(
          'source_path_unsafe',
          `Skill Pack contains a non-regular file: ${relativePath}`
        )
      }
      if (!isPathWithinRoot(canonicalRoot, resolve(absolutePath))) {
        throw new SkillPackResolutionError(
          'source_path_unsafe',
          `Skill Pack path escapes its source root: ${relativePath}`
        )
      }
      totalBytes += entryStats.size
      if (files.length + 1 > MAX_FILES || totalBytes > MAX_TOTAL_BYTES) {
        throw new SkillPackResolutionError(
          'limit_exceeded',
          `Skill Pack exceeds the ${MAX_FILES} file or ${MAX_TOTAL_BYTES} byte limit`
        )
      }
      files.push({
        absolutePath,
        digest: await digestFile(absolutePath),
        mode: entryStats.mode,
        relativePath,
        size: entryStats.size,
      })
    }
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

const buildSkillManifest = async (
  skillFile: InventoriedFile,
  allFiles: InventoriedFile[],
  options: InspectSkillPackTreeOptions
): Promise<SkillPackManifestSkill> => {
  if (skillFile.size > MAX_SKILL_MD_BYTES) {
    throw new SkillPackResolutionError(
      'limit_exceeded',
      `SKILL.md exceeds ${MAX_SKILL_MD_BYTES} bytes: ${skillFile.relativePath}`
    )
  }
  const skillDirectory = dirname(skillFile.relativePath).replaceAll('\\', '/')
  const directoryName = skillDirectory === '.' ? 'root' : (skillDirectory.split('/').at(-1) ?? '')
  let metadata: ReturnType<typeof parseSkillMarkdown>
  try {
    const rawBuffer = await readFile(skillFile.absolutePath)
    if (!isUtf8(rawBuffer) || rawBuffer.includes(0)) {
      throw new Error('SKILL.md contains binary data')
    }
    const raw = rawBuffer.toString('utf8')
    metadata = parseSkillMarkdown(raw, directoryName)
  } catch (error) {
    throw new SkillPackResolutionError(
      'invalid_skill',
      `Cannot parse ${skillFile.relativePath}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (metadata.validationErrors.length > 0 || !metadata.description) {
    throw new SkillPackResolutionError(
      'invalid_skill',
      `Invalid ${skillFile.relativePath}: ${metadata.validationErrors.join(', ')}`
    )
  }
  const prefix = skillDirectory === '.' ? '' : `${skillDirectory}/`
  const files = allFiles.filter((file) => !prefix || file.relativePath.startsWith(prefix))
  const scriptPaths = files
    .filter((file) => isSkillScriptOrExecutable(file.relativePath, executableMode(file, options)))
    .map((file) => file.relativePath)
  return {
    containsScripts: scriptPaths.length > 0,
    contentDigest: digestInventory(files, options),
    description: metadata.description,
    explicitOnly: metadata.explicitOnly,
    fileCount: files.length,
    instructionDigest: `sha256:${skillFile.digest}`,
    name: metadata.name,
    relativePath: skillDirectory,
    scriptPaths,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
  }
}

export const inspectSkillPackTree = async (
  rootPath: string,
  options: InspectSkillPackTreeOptions = {}
): Promise<InspectedSkillPackTree> => {
  const files = await inventoryTree(rootPath)
  if (options.executablePaths) {
    const inventoriedPaths = new Set(files.map((file) => file.relativePath))
    const missingExecutablePaths = [...options.executablePaths].filter(
      (path) => !inventoriedPaths.has(path)
    )
    if (missingExecutablePaths.length > 0) {
      throw new SkillPackResolutionError(
        'source_path_unsafe',
        `Executable paths are missing from the Skill Pack tree: ${missingExecutablePaths.join(', ')}`
      )
    }
  }
  const skillFiles = files.filter(
    (file) => file.relativePath === 'SKILL.md' || file.relativePath.endsWith('/SKILL.md')
  )
  if (skillFiles.length === 0) {
    throw new SkillPackResolutionError('invalid_source', 'Skill Pack contains no SKILL.md files')
  }
  const skills = await Promise.all(
    skillFiles.map((skillFile) => buildSkillManifest(skillFile, files, options))
  )
  const duplicateNames = Array.from(
    skills.reduce((counts, skill) => {
      counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1)
      return counts
    }, new Map<string, number>())
  )
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort()
  if (duplicateNames.length > 0) {
    throw new SkillPackResolutionError(
      'duplicate_skill_name',
      `Duplicate Skill names in Pack: ${duplicateNames.join(', ')}`
    )
  }
  return {
    contentDigest: digestInventory(files, options),
    manifest: {
      executablePaths: files
        .filter((file) => executableMode(file, options) !== 0)
        .map((file) => file.relativePath),
      fileCount: files.length,
      skills: skills.sort((left, right) => left.name.localeCompare(right.name)),
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    },
  }
}

export const inspectCachedSkillPackTree = (
  rootPath: string,
  manifest: Pick<SkillPackManifest, 'executablePaths'>
) =>
  inspectSkillPackTree(
    rootPath,
    process.platform === 'win32'
      ? { executablePaths: new Set(manifest.executablePaths ?? []) }
      : undefined
  )
