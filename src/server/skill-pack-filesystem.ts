import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

import { isPathWithinRoot } from './fs-sandbox.js'
import type { SkillFileState, SkillLinkState } from './skill-pack-change-types.js'
import { fingerprintContent } from './skill-pack-config.js'
import { SkillPackChangeError } from './skill-pack-operation-errors.js'

const pathExists = async (path: string) => {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

const normalizePathForFingerprint = (path: string) =>
  process.platform === 'win32' ? resolve(path).toLocaleLowerCase('en-US') : resolve(path)

export const fingerprintLinkTarget = (target: string) =>
  `link:${createHash('sha256').update(normalizePathForFingerprint(target)).digest('hex')}`

export const observeLinkState = async (path: string): Promise<SkillLinkState> => {
  try {
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) {
      const rawTarget = await readlink(path)
      const target = resolve(dirname(path), rawTarget)
      return { fingerprint: fingerprintLinkTarget(target), target }
    }
    const kind = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'special'
    const occupied = `${kind}\0${stats.size}\0${stats.mtimeMs}\0${stats.mode}`
    return {
      fingerprint: `occupied:${createHash('sha256').update(occupied).digest('hex')}`,
      target: null,
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { fingerprint: 'missing', target: null }
    }
    throw error
  }
}

export const observeFileState = async (path: string): Promise<SkillFileState> => {
  try {
    const stats = await lstat(path)
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new SkillPackChangeError(
        'path_unsafe',
        `Managed file path is not a regular file: ${path}`
      )
    }
    const content = await readFile(path, 'utf8')
    return { content, fingerprint: fingerprintContent(content) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { content: null, fingerprint: 'missing' }
    }
    throw error
  }
}

const ensureSafeDirectory = async (workspacePath: string, directoryPath: string) => {
  const workspaceRoot = await realpath(workspacePath)
  const resolvedDirectory = resolve(directoryPath)
  if (!isPathWithinRoot(workspaceRoot, resolvedDirectory)) {
    throw new SkillPackChangeError(
      'path_unsafe',
      `Managed path escapes workspace: ${directoryPath}`
    )
  }

  const relativeDirectory = relative(workspaceRoot, resolvedDirectory)
  let current = workspaceRoot
  for (const segment of relativeDirectory.split(sep).filter(Boolean)) {
    current = join(current, segment)
    if (!(await pathExists(current))) {
      await mkdir(current)
      continue
    }
    const stats = await lstat(current)
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new SkillPackChangeError('path_unsafe', `Managed directory is unsafe: ${current}`)
    }
    const canonical = await realpath(current)
    if (!isPathWithinRoot(workspaceRoot, canonical)) {
      throw new SkillPackChangeError(
        'path_unsafe',
        `Managed directory escapes workspace: ${current}`
      )
    }
  }
}

const assertManagedPath = async (workspacePath: string, path: string) => {
  const workspaceRoot = await realpath(workspacePath)
  const target = resolve(path)
  if (!isPathWithinRoot(workspaceRoot, target)) {
    throw new SkillPackChangeError('path_unsafe', `Managed target escapes workspace: ${path}`)
  }
  await ensureSafeDirectory(workspaceRoot, dirname(target))
}

export const applyFileState = async (input: {
  expected: SkillFileState
  next: SkillFileState
  path: string
  workspacePath: string
}) => {
  await assertManagedPath(input.workspacePath, input.path)
  const current = await observeFileState(input.path)
  if (current.fingerprint !== input.expected.fingerprint) {
    throw new SkillPackChangeError('drift_detected', `Managed file changed: ${input.path}`)
  }
  if (input.next.content === null) {
    if (current.content !== null) await rm(input.path)
    return
  }
  if (fingerprintContent(input.next.content) !== input.next.fingerprint) {
    throw new SkillPackChangeError('path_unsafe', `Invalid planned file fingerprint: ${input.path}`)
  }
  const temporaryPath = join(dirname(input.path), `.${randomUUID()}.hive-tmp`)
  try {
    await writeFile(temporaryPath, input.next.content, { encoding: 'utf8', flag: 'wx' })
    await rename(temporaryPath, input.path)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

export const applyLinkState = async (input: {
  expected: SkillLinkState
  next: SkillLinkState
  path: string
  workspacePath: string
}) => {
  await assertManagedPath(input.workspacePath, input.path)
  const current = await observeLinkState(input.path)
  if (current.fingerprint !== input.expected.fingerprint) {
    throw new SkillPackChangeError(
      'drift_detected',
      `Native Skill placement changed: ${input.path}`
    )
  }
  if (input.next.target === null) {
    if (current.fingerprint !== 'missing') {
      const stats = await lstat(input.path)
      if (!stats.isSymbolicLink()) {
        throw new SkillPackChangeError(
          'placement_conflict',
          `Refusing to remove unmanaged native Skill path: ${input.path}`
        )
      }
      await rm(input.path)
    }
    return
  }
  if (fingerprintLinkTarget(input.next.target) !== input.next.fingerprint) {
    throw new SkillPackChangeError('path_unsafe', `Invalid planned link fingerprint: ${input.path}`)
  }
  const sourceStats = await lstat(input.next.target)
  if (!sourceStats.isDirectory()) {
    throw new SkillPackChangeError(
      'release_unavailable',
      `Native Skill source is unavailable: ${input.next.target}`
    )
  }
  if (current.fingerprint !== 'missing') {
    throw new SkillPackChangeError(
      'placement_conflict',
      `Native Skill target already exists: ${input.path}`
    )
  }
  const temporaryPath = join(dirname(input.path), `.${randomUUID()}.hive-link`)
  try {
    await symlink(
      input.next.target,
      temporaryPath,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await rename(temporaryPath, input.path)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}
