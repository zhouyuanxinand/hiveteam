import { chmod, copyFile, lstat, rm } from 'node:fs/promises'
import { posix, resolve } from 'node:path'

import { isPathWithinRoot } from './fs-sandbox.js'
import { SkillPackResolutionError } from './skill-pack-source.js'
import { inspectSkillPackTree } from './skill-pack-tree.js'

const GIT_TREE_ENTRY =
  /^(?<mode>[0-7]{6}) (?<type>[a-z]+) (?<object>[a-f0-9]{40}|[a-f0-9]{64})\t(?<path>[\s\S]+)$/u

interface GitTreeEntry {
  mode: string
  objectId: string
  path: string
  type: string
}

type GitBlobReader = (objectId: string) => Promise<string>

const unsupportedEntry = (entry: GitTreeEntry) =>
  new SkillPackResolutionError(
    'source_path_unsafe',
    `Skill Pack Git tree contains an unsupported entry: ${entry.path} (${entry.mode} ${entry.type})`
  )

const parseGitTree = (treeOutput: string): GitTreeEntry[] => {
  const entries: GitTreeEntry[] = []
  const seenPaths = new Set<string>()
  for (const record of treeOutput.split('\0')) {
    if (!record) continue
    const match = GIT_TREE_ENTRY.exec(record)
    const mode = match?.groups?.mode
    const objectId = match?.groups?.object
    const type = match?.groups?.type
    const path = match?.groups?.path
    if (!mode || !objectId || !type || !path) {
      throw new SkillPackResolutionError('git_failed', 'Git returned an invalid tree entry')
    }
    if (seenPaths.has(path)) {
      throw new SkillPackResolutionError(
        'git_failed',
        `Git returned a duplicate tree path: ${path}`
      )
    }
    seenPaths.add(path)
    const entry = { mode, objectId, path, type }
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755' && mode !== '120000')) {
      throw unsupportedEntry(entry)
    }
    entries.push(entry)
  }
  return entries
}

const executablePathsFromEntries = (entries: GitTreeEntry[]): Set<string> => {
  const executablePaths = new Set<string>()
  for (const entry of entries) {
    if (entry.mode === '100755') executablePaths.add(entry.path)
  }
  return executablePaths
}

export const executablePathsFromGitTree = (treeOutput: string): Set<string> =>
  executablePathsFromEntries(parseGitTree(treeOutput))

const materializedPath = (rootPath: string, gitPath: string) => {
  if (gitPath.includes('\\') || posix.isAbsolute(gitPath)) {
    throw new SkillPackResolutionError(
      'source_path_unsafe',
      `Skill Pack Git path is not portable: ${gitPath}`
    )
  }
  const normalized = posix.normalize(gitPath)
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new SkillPackResolutionError(
      'source_path_unsafe',
      `Skill Pack Git path escapes its source root: ${gitPath}`
    )
  }
  const absolutePath = resolve(rootPath, ...normalized.split('/'))
  if (!isPathWithinRoot(rootPath, absolutePath)) {
    throw new SkillPackResolutionError(
      'source_path_unsafe',
      `Skill Pack Git path escapes its source root: ${gitPath}`
    )
  }
  return absolutePath
}

const resolveSymlinkTarget = (linkPath: string, rawTarget: string) => {
  if (
    !rawTarget ||
    rawTarget.includes('\0') ||
    rawTarget.includes('\\') ||
    posix.isAbsolute(rawTarget)
  ) {
    throw new SkillPackResolutionError(
      'source_path_unsafe',
      `Skill Pack symbolic link has an unsafe target: ${linkPath}`
    )
  }
  const targetPath = posix.normalize(posix.join(posix.dirname(linkPath), rawTarget))
  if (targetPath === '..' || targetPath.startsWith('../') || posix.isAbsolute(targetPath)) {
    throw new SkillPackResolutionError(
      'source_path_unsafe',
      `Skill Pack symbolic link escapes its source root: ${linkPath}`
    )
  }
  return targetPath
}

const materializeFileSymlinks = async (
  rootPath: string,
  entries: GitTreeEntry[],
  readBlob?: GitBlobReader
) => {
  const symlinks = entries.filter((entry) => entry.mode === '120000')
  if (symlinks.length === 0) return
  if (!readBlob) {
    throw new SkillPackResolutionError(
      'git_failed',
      'Git blob access is required to inspect symbolic links'
    )
  }
  const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]))
  for (const link of symlinks) {
    const targetPath = resolveSymlinkTarget(link.path, await readBlob(link.objectId))
    const target = entriesByPath.get(targetPath)
    if (
      !target ||
      target.type !== 'blob' ||
      (target.mode !== '100644' && target.mode !== '100755')
    ) {
      throw new SkillPackResolutionError(
        'source_path_unsafe',
        `Skill Pack symbolic link must target a regular file in the same tree: ${link.path}`
      )
    }
    const linkAbsolutePath = materializedPath(rootPath, link.path)
    const targetAbsolutePath = materializedPath(rootPath, target.path)
    const targetStats = await lstat(targetAbsolutePath)
    if (!targetStats.isFile() || targetStats.isSymbolicLink()) {
      throw new SkillPackResolutionError(
        'source_path_unsafe',
        `Skill Pack symbolic link target is not a regular file: ${link.path}`
      )
    }
    await rm(linkAbsolutePath, { force: true })
    await copyFile(targetAbsolutePath, linkAbsolutePath)
    await chmod(linkAbsolutePath, 0o644)
  }
}

export const inspectGitSkillPackTree = async (
  rootPath: string,
  treeOutput: string,
  readBlob?: GitBlobReader
) => {
  const entries = parseGitTree(treeOutput)
  await materializeFileSymlinks(rootPath, entries, readBlob)
  return inspectSkillPackTree(rootPath, {
    executablePaths: executablePathsFromEntries(entries),
  })
}
