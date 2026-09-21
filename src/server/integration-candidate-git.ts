import { lstat, mkdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { IntegrationCandidate } from '../shared/integration-candidate.js'
import { readCodeReviewPatch } from './code-review-git.js'
import { GitCommandError, runGit } from './git-command.js'
import { ConflictError } from './http-errors.js'

export const candidateGit = async (cwd: string, hooks: string, args: string[]) => {
  let configured = ''
  try {
    configured = await runGit(cwd, [
      'config',
      '--null',
      '--get-regexp',
      '^(filter\\..*\\.(clean|smudge|process|required)|merge\\..*\\.driver)$',
    ])
  } catch (error) {
    if (!(error instanceof GitCommandError) || error.exitCode !== 1) throw error
  }
  const overrides = configured
    .split('\0')
    .filter(Boolean)
    .flatMap((entry) => {
      const key = entry.split('\n')[0]
      if (!key) return []
      return ['-c', `${key}=${key.endsWith('.driver') || key.endsWith('.required') ? 'false' : ''}`]
    })
  return runGit(
    cwd,
    [
      '-c',
      `core.hooksPath=${hooks}`,
      '-c',
      'commit.gpgSign=false',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'rerere.enabled=false',
      '-c',
      'core.attributesFile=',
      ...overrides,
      ...args,
    ],
    { timeout: 60000, env: { GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' } }
  )
}
export const candidateConflicts = async (candidate: IntegrationCandidate) =>
  (await runGit(candidate.checkout_path, ['diff', '--name-only', '--diff-filter=U', '-z']))
    .split('\0')
    .filter(Boolean)
export const candidateHooks = (candidate: IntegrationCandidate) =>
  join(dirname(candidate.checkout_path), 'empty-hooks')
export const assertCandidatePath = async (
  dataDir: string,
  candidate: IntegrationCandidate,
  repoRoot: string
) => {
  const root = resolve(dataDir, 'integration-candidates')
  if (
    candidate.checkout_path !== join(root, candidate.id, 'checkout') ||
    !(await realpath(candidate.checkout_path)).startsWith(`${await realpath(root)}${sep}`)
  )
    throw new ConflictError('Integration candidate directory was redirected.')
  const common = async (cwd: string) =>
    realpath(
      (await runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
    )
  if ((await common(candidate.checkout_path)) !== (await common(repoRoot)))
    throw new ConflictError('Candidate no longer belongs to the source repository.')
}
export const prepareCandidateGit = async (candidate: IntegrationCandidate, repoRoot: string) => {
  const root = dirname(dirname(candidate.checkout_path))
  const repo = await realpath(repoRoot)
  const data = await realpath(dirname(root))
  const distance = relative(repo, data)
  if (!distance || (!isAbsolute(distance) && distance !== '..' && !distance.startsWith(`..${sep}`)))
    throw new ConflictError('Candidate storage must be outside the source repository.')
  await mkdir(root, { recursive: true, mode: 0o700 })
  if (
    (await lstat(root)).isSymbolicLink() ||
    relative(join(data, 'integration-candidates'), await realpath(root))
  )
    throw new ConflictError('Candidate storage was redirected.')
  await mkdir(dirname(candidate.checkout_path), { mode: 0o700 })
  const hooks = candidateHooks(candidate)
  await mkdir(hooks, { recursive: true })
  await candidateGit(repoRoot, hooks, [
    'worktree',
    'add',
    '--detach',
    candidate.checkout_path,
    candidate.target_sha,
  ])
  try {
    await candidateGit(candidate.checkout_path, hooks, [
      'merge',
      '--no-ff',
      '--no-commit',
      candidate.source_sha,
    ])
  } catch (error) {
    if (
      !(error instanceof GitCommandError) ||
      error.exitCode !== 1 ||
      !(await candidateConflicts(candidate)).length
    )
      throw error
    return { conflicted: true, sha: null }
  }
  return finishCandidateGit(candidate)
}
export const finishCandidateGit = async (candidate: IntegrationCandidate) => {
  const hooks = candidateHooks(candidate)
  if ((await candidateConflicts(candidate)).length)
    throw new ConflictError(
      'Resolve and stage the listed conflicts in the candidate directory first.'
    )
  const operation = (
    await runGit(candidate.checkout_path, ['rev-parse', '--git-path', 'MERGE_HEAD'])
  ).trim()
  const { readFile } = await import('node:fs/promises')
  let mergeHead: string | null = null
  try {
    mergeHead = (await readFile(resolve(candidate.checkout_path, operation), 'utf8')).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (mergeHead) {
    if (
      mergeHead !== candidate.source_sha ||
      (await runGit(candidate.checkout_path, ['rev-parse', 'HEAD'])).trim() !== candidate.target_sha
    )
      throw new ConflictError('Candidate merge parents changed. Prepare a new candidate.')
    await candidateGit(candidate.checkout_path, hooks, [
      '-c',
      'user.name=Hive integration',
      '-c',
      'user.email=hive@localhost',
      'commit',
      '--no-edit',
      '-m',
      `Integrate reviewed source ${candidate.source_sha}`,
    ])
  }
  const sha = (await runGit(candidate.checkout_path, ['rev-parse', 'HEAD'])).trim()
  for (const parent of [candidate.source_sha, candidate.target_sha])
    await candidateGit(candidate.checkout_path, hooks, ['merge-base', '--is-ancestor', parent, sha])
  return { conflicted: false, sha }
}
export const candidatePatch = (candidate: IntegrationCandidate, relativePath: string | null) =>
  readCodeReviewPatch({
    version: candidate.candidate_sha
      ? {
          repository_id: candidate.repository_id,
          source_sha: candidate.candidate_sha,
          base_sha: candidate.target_sha,
          report_revision: candidate.report_revision,
        }
      : null,
    repoRoot: candidate.checkout_path,
    relativePath,
    baseline_kind: 'target_head',
    is_dirty: false,
    unavailable_reason: null,
  })

/** Ref CAS prevents a target movement from reusing an acceptance of another baseline. */
export const installCandidate = async (candidate: IntegrationCandidate, repoRoot: string) => {
  if (!candidate.candidate_sha) throw new ConflictError('The candidate has no commit.')
  await candidateGit(repoRoot, candidateHooks(candidate), [
    'merge-base',
    '--is-ancestor',
    candidate.target_sha,
    candidate.candidate_sha,
  ])
  await candidateGit(repoRoot, candidateHooks(candidate), [
    'update-ref',
    `refs/heads/${candidate.target_branch}`,
    candidate.candidate_sha,
    candidate.target_sha,
  ])
  await finishCandidateCheckout(candidate, repoRoot)
}
export const finishCandidateCheckout = async (
  candidate: IntegrationCandidate,
  repoRoot: string
) => {
  if (!candidate.candidate_sha) throw new ConflictError('The candidate has no commit.')
  const hooks = candidateHooks(candidate)
  if (
    (await candidateGit(repoRoot, hooks, ['symbolic-ref', 'HEAD'])).trim() !==
    `refs/heads/${candidate.target_branch}`
  )
    throw new ConflictError('Restore the recorded target branch before completing integration.')
  const indexTree = (await candidateGit(repoRoot, hooks, ['write-tree'])).trim()
  const before = (
    await candidateGit(repoRoot, hooks, ['rev-parse', `${candidate.target_sha}^{tree}`])
  ).trim()
  const after = (
    await candidateGit(repoRoot, hooks, ['rev-parse', `${candidate.candidate_sha}^{tree}`])
  ).trim()
  if (indexTree !== before && indexTree !== after)
    throw new ConflictError('Target index changed during integration. Inspect it before recovery.')
  await candidateGit(repoRoot, hooks, ['diff-files', '--quiet'])
  if (indexTree === before)
    await candidateGit(repoRoot, hooks, [
      'read-tree',
      '-u',
      '-m',
      candidate.target_sha,
      candidate.candidate_sha,
    ])
}
