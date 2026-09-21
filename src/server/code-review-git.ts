import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { CodeReviewVersion } from '../shared/code-review.js'
import { CodeReviewError } from './code-review-error.js'
import { isSensitiveExecutionName } from './execution-filesystem.js'
import { runGit as executeGit, GitCommandError } from './git-command.js'
import { readVerificationVersion } from './verification-worktree.js'

const PATCH_LIMIT = 512 * 1024
const FILE_LIMIT = 256 * 1024
// Commit evidence refers to stored objects, never a local replace-ref overlay.
const runGit: typeof executeGit = (cwd, args, options = {}) =>
  executeGit(cwd, args, {
    ...options,
    env: { ...options.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' },
  })
const hiddenPath = (path: string) =>
  path
    .split('/')
    .some((part) => part.toLowerCase() === '.git' || isSensitiveExecutionName(part.toLowerCase()))

/** A checkout and all its worktrees share this identity; replacing .git changes it. */
const repositoryId = async (cwd: string) => {
  const common = await realpath(
    (await runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
  )
  const information = await stat(common)
  return createHash('sha256')
    .update(JSON.stringify([common, information.dev, information.ino, information.birthtimeMs]))
    .digest('hex')
}

export const readCodeReviewVersion = async (input: {
  sourcePath: string
  targetPath: string
  reportRevision: number
  dispatchBase: string | null
  targetBranch?: string
}) => {
  const source = await readVerificationVersion(input.sourcePath)
  const target =
    resolve(input.sourcePath) === resolve(input.targetPath)
      ? source
      : await readVerificationVersion(input.targetPath)
  const isolated = !!input.targetBranch
  const baselineKind = isolated ? ('target_head' as const) : ('dispatch_base' as const)
  const baseSha = isolated ? target.headSha : input.dispatchBase
  let reason = source.unavailableReason ?? target.unavailableReason
  let version: CodeReviewVersion | null = null
  if (!reason && source.repoRoot && target.repoRoot && source.headSha && baseSha) {
    try {
      const [sourceId, targetId] = await Promise.all([
        repositoryId(source.repoRoot),
        repositoryId(target.repoRoot),
      ])
      if (sourceId !== targetId)
        reason = 'The source checkout no longer belongs to the workspace repository.'
      else if (isolated && (!('branch' in target) || target.branch !== input.targetBranch))
        reason = 'The target branch changed. Restore the recorded target before reviewing.'
      else {
        const resolved = (
          await runGit(source.repoRoot, ['rev-parse', '--verify', `${baseSha}^{commit}`])
        ).trim()
        if (resolved !== baseSha) reason = 'The comparison baseline is not a full commit SHA.'
        else
          version = {
            repository_id: sourceId,
            source_sha: source.headSha,
            base_sha: baseSha,
            report_revision: input.reportRevision,
          }
      }
    } catch (error) {
      if (!(error instanceof GitCommandError)) throw error
      reason = error.message
    }
  }
  return {
    version,
    baseline_kind: baselineKind,
    unavailable_reason:
      reason ??
      (version ? null : 'A Git commit and dispatch baseline are required for code review.'),
    is_dirty: source.isDirty || (isolated && target.isDirty),
    repoRoot: source.repoRoot,
    relativePath: source.relativePath,
  }
}

export type CodeReviewGitVersion = Awaited<ReturnType<typeof readCodeReviewVersion>>

export const readCodeReviewPatch = async (current: CodeReviewGitVersion) => {
  if (!current.version || !current.repoRoot)
    return { patch: '', patch_truncated: false, omitted_sensitive_files: 0 }
  const { source_sha, base_sha } = current.version
  const scope = current.relativePath ? [`:(literal)${current.relativePath}`] : []
  const files = (
    await runGit(current.repoRoot, [
      'diff',
      '--no-renames',
      '--name-only',
      '-z',
      base_sha,
      source_sha,
      '--',
      ...scope,
    ])
  )
    .split('\0')
    .filter(Boolean)
  const visible = files.filter((file) => !hiddenPath(file))
  let patch = ''
  let index = 0
  // Bound each argv on Windows and the returned patch. Full text files remain readable by SHA.
  while (index < visible.length && patch.length < PATCH_LIMIT) {
    const chunk: string[] = []
    let length = 0
    while (index < visible.length && length < 8000) {
      const file = visible[index++]
      if (file) {
        chunk.push(`:(literal)${file}`)
        length += file.length + 12
      }
    }
    patch += await runGit(
      current.repoRoot,
      [
        'diff',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        base_sha,
        source_sha,
        '--',
        ...chunk,
      ],
      { maxBuffer: 16 * 1024 * 1024 }
    )
  }
  return {
    patch: patch.slice(0, PATCH_LIMIT),
    patch_truncated: index < visible.length || patch.length > PATCH_LIMIT,
    omitted_sensitive_files: files.length - visible.length,
  }
}

export const readCodeReviewFile = async (
  current: CodeReviewGitVersion,
  path: string,
  side: 'source' | 'base'
) => {
  if (!current.version || !current.repoRoot)
    throw new CodeReviewError('review_unavailable', 'Git source is unavailable.')
  if (
    !path ||
    path.length > 2000 ||
    path.includes('\\') ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject Git syntax and control characters in user paths.
    /[\x00-\x1f\x7f:]/u.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..') ||
    hiddenPath(path)
  )
    throw new CodeReviewError(
      'review_file_unavailable',
      'Choose a non-sensitive text file within this workspace.',
      400
    )
  const scoped = current.relativePath ? `${current.relativePath}/${path}` : path
  const sha = side === 'source' ? current.version.source_sha : current.version.base_sha
  const entry = (
    await runGit(current.repoRoot, [
      'ls-tree',
      '-z',
      '--full-tree',
      sha,
      '--',
      `:(literal)${scoped}`,
    ])
  )
    .split('\0')
    .filter(Boolean)
  const match =
    entry.length === 1 ? /^(100644|100755) blob ([a-f0-9]+)\t(.*)$/su.exec(entry[0] ?? '') : null
  if (!match || match[3] !== scoped)
    throw new CodeReviewError(
      'review_file_unavailable',
      'Only regular files in the reviewed commit can be read.',
      404
    )
  const blob = match[2] ?? ''
  const size = Number((await runGit(current.repoRoot, ['cat-file', '-s', blob])).trim())
  if (size > FILE_LIMIT)
    throw new CodeReviewError(
      'review_file_unavailable',
      'This file exceeds the 256 KiB review limit.',
      413
    )
  const content = await runGit(current.repoRoot, ['cat-file', 'blob', blob], {
    maxBuffer: FILE_LIMIT + 1024,
  })
  if (content.includes('\0'))
    throw new CodeReviewError(
      'review_file_unavailable',
      'Binary files cannot be displayed as review text.',
      415
    )
  return { version: current.version, path, side, content }
}
