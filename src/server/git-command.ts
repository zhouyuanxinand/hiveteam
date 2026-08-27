import { execFile } from 'node:child_process'
import { relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const GIT_TIMEOUT_MS = 10_000
const GIT_LOG_MAX_BUFFER = 4 * 1024 * 1024

export class GitCommandError extends Error {
  readonly exitCode: number | null
  readonly kind: 'failed' | 'unavailable'

  constructor(
    message: string,
    input: { exitCode?: number | null; kind?: 'failed' | 'unavailable' } = {}
  ) {
    super(message)
    this.name = 'GitCommandError'
    this.exitCode = input.exitCode ?? null
    this.kind = input.kind ?? 'failed'
  }
}

const readErrorCode = (error: unknown): string | number | null => {
  if (!error || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' || typeof code === 'number' ? code : null
}

const readExitCode = (error: unknown): number | null => {
  if (!error || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'number' ? code : null
}

export const runGit = async (
  cwd: string,
  args: string[],
  options: { timeout?: number; maxBuffer?: number } = {}
): Promise<string> => {
  try {
    const result = await execFileP('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: options.maxBuffer ?? GIT_LOG_MAX_BUFFER,
      timeout: options.timeout ?? GIT_TIMEOUT_MS,
      windowsHide: true,
    })
    return String(result.stdout)
  } catch (error) {
    const code = readErrorCode(error)
    const message = error instanceof Error ? error.message : String(error)
    if (code === 'ENOENT') {
      throw new GitCommandError('Git executable was not found on PATH.', { kind: 'unavailable' })
    }
    throw new GitCommandError(message, { exitCode: readExitCode(error) })
  }
}

const tryRunGit = async (cwd: string, args: string[]) => {
  try {
    return await runGit(cwd, args)
  } catch {
    return null
  }
}

export interface GitRepositoryInfo {
  branch: string | null
  headSha: string | null
  relativePath: string | null
  repoRoot: string
}

export const detectGitRepository = async (workspacePath: string): Promise<GitRepositoryInfo> => {
  const output = await runGit(workspacePath, [
    'rev-parse',
    '--show-toplevel',
    '--absolute-git-dir',
    '--is-inside-work-tree',
    '--abbrev-ref',
    'HEAD',
  ])
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
  const repoRoot = resolve(lines[0] ?? workspacePath)
  const branchValue = lines[3] ?? null
  const relativeValue = relative(repoRoot, resolve(workspacePath)).replaceAll('\\', '/')
  return {
    branch: branchValue && branchValue !== 'HEAD' ? branchValue : null,
    headSha: await tryRunGit(repoRoot, ['rev-parse', '--verify', 'HEAD']).then(
      (value) => value?.trim() || null
    ),
    relativePath: relativeValue || null,
    repoRoot,
  }
}

export interface GitStatusDetails {
  changedFileCount: number
  isDirty: boolean
  stagedFileCount: number
  untrackedFileCount: number
}

const getScopeArgs = (relativePath: string | null) => {
  const workspacePath = relativePath ?? '.'
  const workspacePrefix = relativePath ? `${relativePath.replace(/\/$/u, '')}/` : ''
  return [
    '--',
    workspacePath,
    `:(exclude)${workspacePrefix}.hive`,
    `:(exclude)${workspacePrefix}.hive/**`,
  ]
}

export const readGitStatus = async (repository: GitRepositoryInfo): Promise<GitStatusDetails> => {
  const output = await runGit(repository.repoRoot, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    ...getScopeArgs(repository.relativePath),
  ])
  const entries = output.split('\0').filter((entry) => entry.length >= 3 && entry[2] === ' ')
  let stagedFileCount = 0
  let untrackedFileCount = 0
  for (const entry of entries) {
    const status = entry.slice(0, 2)
    if (status === '??') {
      untrackedFileCount += 1
    } else if (status[0] !== ' ') {
      stagedFileCount += 1
    }
  }
  return {
    changedFileCount: entries.length,
    isDirty: entries.length > 0,
    stagedFileCount,
    untrackedFileCount,
  }
}

export const listStagedFiles = async (repository: GitRepositoryInfo) => {
  const output = await runGit(repository.repoRoot, [
    'diff',
    '--cached',
    '--name-only',
    '-z',
    ...getScopeArgs(repository.relativePath),
  ])
  return output.split('\0').filter(Boolean)
}

const parseGitDate = (value: string) => {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export interface GitCommitDetails {
  authorEmail: string
  authorName: string
  authoredAt: number
  changedFiles: number
  committedAt: number
  deletions: number
  insertions: number
  message: string
  parents: string[]
  sha: string
}

const parseNumstat = (lines: string[]) => {
  let changedFiles = 0
  let insertions = 0
  let deletions = 0
  for (const line of lines) {
    const match = /^(\d+|-)\t(\d+|-)\t/u.exec(line)
    if (!match) continue
    changedFiles += 1
    if (match[1] !== '-') insertions += Number(match[1])
    if (match[2] !== '-') deletions += Number(match[2])
  }
  return { changedFiles, deletions, insertions }
}

const parseCommitRecord = (record: string): GitCommitDetails | null => {
  const lines = record.replace(/^\r?\n/u, '').split(/\r?\n/u)
  const headerIndex = lines.findIndex((line) => line.includes('\0'))
  if (headerIndex < 0) return null
  const header = lines[headerIndex]
  if (!header) return null
  const fields = header.split('\0')
  if (fields.length < 7 || !fields[0]) return null
  const stats = parseNumstat(lines.slice(headerIndex + 1))
  return {
    authorEmail: fields[3] ?? '',
    authorName: fields[2] ?? '',
    authoredAt: parseGitDate(fields[4] ?? ''),
    ...stats,
    committedAt: parseGitDate(fields[5] ?? ''),
    message: fields[6] ?? '',
    parents: (fields[1] ?? '').split(' ').filter(Boolean),
    sha: fields[0] ?? '',
  }
}

const formatArgs = (limit: number, offset: number) => [
  'log',
  `--max-count=${limit}`,
  `--skip=${offset}`,
  '--format=%x1e%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s',
  '--numstat',
]

export const listGitCommits = async (
  repository: GitRepositoryInfo,
  input: { limit: number; offset: number }
) => {
  const output = await runGit(repository.repoRoot, [
    ...formatArgs(input.limit + 1, input.offset),
    ...getScopeArgs(repository.relativePath),
  ])
  return output
    .split('\x1e')
    .map(parseCommitRecord)
    .filter((commit): commit is GitCommitDetails => commit !== null)
}

export const getGitCommit = async (
  repository: GitRepositoryInfo,
  sha: string
): Promise<GitCommitDetails> => {
  const output = await runGit(repository.repoRoot, [
    'show',
    '--format=%x1e%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s',
    '--numstat',
    '--no-renames',
    sha,
    ...getScopeArgs(repository.relativePath),
  ])
  const commit = output
    .split('\x1e')
    .map(parseCommitRecord)
    .find((value): value is GitCommitDetails => value !== null)
  if (!commit) throw new GitCommandError(`Git commit not found: ${sha}`)
  return commit
}

export const isGitAncestor = async (
  repository: GitRepositoryInfo,
  ancestorSha: string,
  descendantSha: string
) => {
  try {
    await runGit(repository.repoRoot, ['merge-base', '--is-ancestor', ancestorSha, descendantSha])
    return true
  } catch {
    return false
  }
}

export const readGitConfig = async (repository: GitRepositoryInfo, key: string) => {
  const value = await tryRunGit(repository.repoRoot, ['config', '--get', key])
  return value?.trim() || null
}

export const getCommitIdentityArgs = async (repository: GitRepositoryInfo) => {
  const [name, email] = await Promise.all([
    readGitConfig(repository, 'user.name'),
    readGitConfig(repository, 'user.email'),
  ])
  const args: string[] = []
  if (!name) args.push('-c', 'user.name=HiveTeam Orchestrator')
  if (!email) args.push('-c', 'user.email=orchestrator@hiveteam.local')
  return args
}

export const stageGitChanges = async (repository: GitRepositoryInfo) => {
  await runGit(repository.repoRoot, ['add', '-A', ...getScopeArgs(repository.relativePath)])
  return listStagedFiles(repository)
}

export const commitGitChanges = async (repository: GitRepositoryInfo, message: string) => {
  const identityArgs = await getCommitIdentityArgs(repository)
  await runGit(repository.repoRoot, [
    ...identityArgs,
    'commit',
    '-m',
    message,
    ...getScopeArgs(repository.relativePath),
  ])
  return getGitCommit(repository, 'HEAD')
}

export const revertGitCommit = async (repository: GitRepositoryInfo, sha: string) => {
  const identityArgs = await getCommitIdentityArgs(repository)
  try {
    await runGit(repository.repoRoot, ['revert', '--no-commit', sha])
    await runGit(repository.repoRoot, [
      ...identityArgs,
      'commit',
      '-m',
      `HiveTeam: revert ${sha.slice(0, 12)}`,
    ])
    return getGitCommit(repository, 'HEAD')
  } catch (error) {
    try {
      await runGit(repository.repoRoot, ['revert', '--abort'])
    } catch {
      try {
        await runGit(repository.repoRoot, ['reset', '--merge', 'HEAD'])
      } catch {
        // Preserve the original Git error. The status endpoint will expose
        // any remaining repository state for the user to inspect.
      }
    }
    throw error
  }
}

export const initializeGitRepository = async (workspacePath: string) => {
  await runGit(workspacePath, ['init'])
  return detectGitRepository(workspacePath)
}
