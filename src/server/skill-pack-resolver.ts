import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

import type { ResolveSkillPackInput, SkillPackRelease } from '../shared/skill-packs.js'
import { isPathWithinRoot } from './fs-sandbox.js'
import { inspectGitSkillPackTree } from './skill-pack-git-tree.js'
import type { createSkillPackReleaseStore } from './skill-pack-release-store.js'
import {
  normalizeResolveSkillPackInput,
  SkillPackResolutionError,
  sourceUriFor,
} from './skill-pack-source.js'
import {
  type InspectedSkillPackTree,
  inspectCachedSkillPackTree,
  inspectSkillPackTree,
} from './skill-pack-tree.js'

interface SkillPackResolverDependencies {
  cacheRoot: string
  releaseStore: ReturnType<typeof createSkillPackReleaseStore>
}

const pathExists = async (path: string) => {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

const runGit = (
  cwd: string,
  args: string[],
  input: { globalConfigPath: string; hooksPath: string },
  options: { trimOutput?: boolean } = {}
): Promise<string> =>
  new Promise((resolveOutput, reject) => {
    execFile(
      'git',
      ['-c', `core.hooksPath=${input.hooksPath}`, '-c', 'submodule.recurse=false', ...args],
      {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: input.globalConfigPath,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
        },
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolveOutput(options.trimOutput === false ? stdout : stdout.trim())
          return
        }
        reject(
          new SkillPackResolutionError(
            'git_failed',
            stderr.trim() || error.message || 'Git command failed'
          )
        )
      }
    )
  })

const stageRemoteSource = async (
  stageRoot: string,
  sourceDirectory: string,
  sourceUri: string,
  ref: string
) => {
  const hooksPath = join(stageRoot, 'disabled-hooks')
  const globalConfigPath = join(stageRoot, 'empty-gitconfig')
  await mkdir(hooksPath, { recursive: true })
  await mkdir(sourceDirectory, { recursive: true })
  await writeFile(globalConfigPath, '', { encoding: 'utf8', flag: 'wx' })
  const gitOptions = { globalConfigPath, hooksPath }
  await runGit(sourceDirectory, ['init', '--quiet'], gitOptions)
  await runGit(sourceDirectory, ['remote', 'add', 'origin', sourceUri], gitOptions)
  await runGit(
    sourceDirectory,
    [
      '-c',
      'protocol.file.allow=never',
      '-c',
      'http.followRedirects=initial',
      'fetch',
      '--depth=1',
      '--no-tags',
      'origin',
      ref,
    ],
    gitOptions
  )
  await runGit(sourceDirectory, ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], gitOptions)
  const revision = await runGit(sourceDirectory, ['rev-parse', 'HEAD'], gitOptions)
  if (!/^[a-f0-9]{40}$/u.test(revision)) {
    throw new SkillPackResolutionError('git_failed', 'Git did not resolve a full commit id')
  }
  const treeOutput = await runGit(
    sourceDirectory,
    ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'],
    gitOptions
  )
  const inspection = await inspectGitSkillPackTree(sourceDirectory, treeOutput, (objectId) =>
    runGit(sourceDirectory, ['cat-file', 'blob', objectId], gitOptions, {
      trimOutput: false,
    })
  )
  await rm(join(sourceDirectory, '.git'), { force: true, recursive: true })
  return { inspection, revision }
}

const stageLocalSource = async (cacheRoot: string, sourcePath: string, sourceDirectory: string) => {
  let canonicalSource: string
  try {
    canonicalSource = await realpath(sourcePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SkillPackResolutionError(
        'source_not_found',
        `Local source not found: ${sourcePath}`
      )
    }
    throw error
  }
  const sourceStats = await stat(canonicalSource)
  if (!sourceStats.isDirectory()) {
    throw new SkillPackResolutionError('invalid_source', 'Local source must be a directory')
  }
  if (
    isPathWithinRoot(cacheRoot, canonicalSource) ||
    isPathWithinRoot(canonicalSource, cacheRoot)
  ) {
    throw new SkillPackResolutionError(
      'source_path_unsafe',
      'Local source must not contain or be contained by the Hive Skill Pack cache'
    )
  }
  await cp(canonicalSource, sourceDirectory, {
    dereference: false,
    filter: (candidate) => {
      const candidateRelativePath = relative(canonicalSource, candidate)
      return !candidateRelativePath.split(sep).includes('.git')
    },
    recursive: true,
    verbatimSymlinks: true,
  })
}

const publishCacheEntry = async (
  cacheDirectory: string,
  stagedSource: string,
  inspection: InspectedSkillPackTree
) => {
  const { contentDigest } = inspection
  const cacheKey = contentDigest.slice('sha256:'.length)
  if (!/^[a-f0-9]{64}$/u.test(cacheKey)) {
    throw new SkillPackResolutionError('invalid_source', 'Invalid Skill Pack content digest')
  }
  const target = resolve(cacheDirectory, cacheKey)
  if (!isPathWithinRoot(cacheDirectory, target)) {
    throw new SkillPackResolutionError('source_path_unsafe', 'Cache target escapes cache root')
  }
  const inspectExisting = () => inspectCachedSkillPackTree(target, inspection.manifest)
  if (await pathExists(target)) {
    const existing = await inspectExisting()
    if (existing.contentDigest !== contentDigest) {
      throw new SkillPackResolutionError(
        'source_path_unsafe',
        `Existing cache entry does not match ${contentDigest}`
      )
    }
    return cacheKey
  }
  try {
    await rename(stagedSource, target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error
    const existing = await inspectExisting()
    if (existing.contentDigest !== contentDigest) throw error
  }
  return cacheKey
}

export interface SkillPackResolver {
  getReleasePath: (release: Pick<SkillPackRelease, 'cacheKey'>) => string
  inspectRelease: (release: SkillPackRelease) => Promise<InspectedSkillPackTree>
  resolve: (input: ResolveSkillPackInput) => Promise<SkillPackRelease>
}

export const createSkillPackResolver = ({
  cacheRoot,
  releaseStore,
}: SkillPackResolverDependencies): SkillPackResolver => {
  const resolvedCacheRoot = resolve(cacheRoot)
  const cacheDirectory = join(resolvedCacheRoot, 'cache')
  const stagingDirectory = join(resolvedCacheRoot, 'staging')
  const getReleasePath = (release: Pick<SkillPackRelease, 'cacheKey'>) => {
    const path = resolve(cacheDirectory, release.cacheKey)
    if (!isPathWithinRoot(cacheDirectory, path)) {
      throw new SkillPackResolutionError('source_path_unsafe', 'Release cache key escapes cache')
    }
    return path
  }

  const resolvePack = async (rawInput: ResolveSkillPackInput): Promise<SkillPackRelease> => {
    const input = normalizeResolveSkillPackInput(rawInput)
    await mkdir(cacheDirectory, { recursive: true })
    await mkdir(stagingDirectory, { recursive: true })
    const stageRoot = join(stagingDirectory, randomUUID())
    const sourceDirectory = join(stageRoot, 'source')
    await mkdir(stageRoot, { recursive: false })
    try {
      const sourceUri = sourceUriFor(input.source)
      let resolvedRevision: string
      let inspection: InspectedSkillPackTree
      if (input.source.type === 'local') {
        await stageLocalSource(resolvedCacheRoot, input.source.path, sourceDirectory)
        resolvedRevision = ''
        inspection = await inspectSkillPackTree(sourceDirectory)
      } else {
        const staged = await stageRemoteSource(
          stageRoot,
          sourceDirectory,
          sourceUri,
          input.source.ref
        )
        resolvedRevision = staged.revision
        inspection = staged.inspection
      }
      if (input.source.type === 'local') {
        resolvedRevision = `local:${inspection.contentDigest.slice('sha256:'.length)}`
      }
      const cacheKey = await publishCacheEntry(cacheDirectory, sourceDirectory, inspection)
      return releaseStore.save(
        {
          cacheKey,
          contentDigest: inspection.contentDigest,
          manifest: inspection.manifest,
          resolvedRevision,
          source: input.source,
          sourceDirty: false,
          sourceUri,
        },
        input.packName
      )
    } finally {
      await rm(stageRoot, { force: true, recursive: true })
    }
  }

  return {
    getReleasePath,
    inspectRelease: async (release) =>
      inspectCachedSkillPackTree(getReleasePath(release), release.manifest),
    resolve: resolvePack,
  }
}
