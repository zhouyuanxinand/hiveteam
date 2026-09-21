import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { HttpError } from './http-errors.js'

type CommitErrorCode =
  | 'controlled_commit_invalid_checkout'
  | 'controlled_commit_conflict'
  | 'controlled_commit_identity_required'
  | 'controlled_commit_failed'

export class ControlledCommitError extends HttpError {
  constructor(
    readonly code: CommitErrorCode,
    message: string
  ) {
    super(code === 'controlled_commit_failed' ? 500 : 409, message)
    this.name = 'ControlledCommitError'
  }
}

export interface RestrictedWorkerCommitInput {
  checkoutPath: string
  repoRoot: string
  branch: string
  expectedHead: string
  message: string
  /** Trusted policy paths, absolute or relative to the registered checkout. */
  deniedPaths?: string[]
}

export interface RestrictedWorkerCommitResult {
  committed: true
  commit_sha: string
  parent_sha: string
  branch: string
  /** The ref CAS succeeded; retrying the commit would be incorrect. */
  index_sync_required?: true
  temporary_cleanup_required?: true
}

const invalid = (message: string): never => {
  throw new ControlledCommitError('controlled_commit_invalid_checkout', message)
}
const conflict = (message: string): never => {
  throw new ControlledCommitError('controlled_commit_conflict', message)
}
const errorCode = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error ? error.code : undefined
const contained = (root: string, path: string) => {
  const part = relative(root, path)
  return !!part && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}
const samePath = (left: string, right: string) =>
  process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right

const regularFile = async (path: string) => {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    invalid('Controlled commits require ordinary files without symbolic or hard links.')
  }
  return info
}

const realDirectory = async (path: string) => {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) invalid('A checkout directory was replaced.')
  return realpath(path)
}

const readMetadata = async (path: string) => {
  await regularFile(path)
  return (await readFile(path, 'utf8')).trim()
}

const inspectRefPath = async (root: string, parts: string[]) => {
  let path = root
  for (const [index, part] of parts.entries()) {
    path = join(path, part)
    try {
      const info = await lstat(path)
      if (
        info.isSymbolicLink() ||
        !samePath(await realpath(path), path) ||
        (index === parts.length - 1 ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())
      )
        invalid('The worker ref or reflog path was redirected.')
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return
      throw error
    }
  }
}

const gitDirectory = async (root: string) => {
  const entry = join(root, '.git')
  const info = await lstat(entry)
  if (info.isSymbolicLink()) invalid('Symbolic Git directories are not allowed.')
  if (info.isDirectory()) return realDirectory(entry)
  const pointer = await readMetadata(entry)
  if (!pointer.startsWith('gitdir: ') || pointer.includes('\n'))
    invalid('Invalid worktree pointer.')
  return realDirectory(resolve(root, pointer.slice(8)))
}

const commonDirectory = async (gitDir: string) => {
  try {
    return realDirectory(resolve(gitDir, await readMetadata(join(gitDir, 'commondir'))))
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return gitDir
    throw error
  }
}

const inspectCheckout = async (input: RestrictedWorkerCommitInput) => {
  const checkout = await realDirectory(input.checkoutPath)
  // Normalize OS aliases in a parent (e.g. macOS /tmp), but refuse a symlink
  // at the checkout itself. Every path read below is relative to this root.
  const repo = await realDirectory(input.repoRoot)
  const gitDir = await gitDirectory(checkout)
  const common = await commonDirectory(await gitDirectory(repo))
  const worktrees = join(common, 'worktrees')
  if (!contained(worktrees, gitDir) || !samePath(dirname(gitDir), worktrees)) {
    invalid('Controlled commits require a registered linked worktree.')
  }
  if (!samePath(await commonDirectory(gitDir), common)) invalid('The worktree repository changed.')
  const backlink = await readMetadata(join(gitDir, 'gitdir'))
  if (!samePath(resolve(gitDir, backlink), join(checkout, '.git'))) {
    invalid('The worktree backlink does not match the registered checkout.')
  }
  if ((await readMetadata(join(gitDir, 'HEAD'))) !== `ref: refs/heads/${input.branch}`) {
    conflict('The worker branch changed. Refresh before committing.')
  }
  for (const marker of [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'rebase-merge',
    'rebase-apply',
  ]) {
    try {
      await lstat(join(gitDir, marker))
      conflict('Finish or abort the current Git operation before committing.')
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
  }
  const objects = await realDirectory(join(common, 'objects'))
  if (!samePath(objects, join(common, 'objects')))
    invalid('Redirected Git objects are not allowed.')
  return { checkout, gitDir, common, objects }
}

const trustedGit = async (roots: string[]) => {
  const pathValue = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1]
  for (const entry of pathValue?.split(delimiter) ?? []) {
    if (!isAbsolute(entry)) continue
    const candidate = join(entry, process.platform === 'win32' ? 'git.exe' : 'git')
    try {
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
      const actual = await realpath(candidate)
      if (roots.some((root) => contained(root, actual) || samePath(root, actual))) continue
      return actual
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(String(errorCode(error)))) throw error
    }
  }
  throw new ControlledCommitError(
    'controlled_commit_failed',
    'A trusted Git executable is required.'
  )
}

const baseEnvironment = () => {
  const allowed = new Set([
    'PATH',
    'SYSTEMROOT',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
  ])
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase()))
  )
}

const runGit = (
  executable: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  input?: Buffer | string
): Promise<{ status: number; output: Buffer }> =>
  new Promise((resolveRun, reject) => {
    const child = execFile(
      executable,
      args,
      {
        cwd,
        env,
        encoding: 'buffer',
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error && typeof error.code !== 'number') {
          reject(
            new ControlledCommitError(
              'controlled_commit_failed',
              'The controlled Git command could not finish.'
            )
          )
        } else
          resolveRun({ status: typeof error?.code === 'number' ? error.code : 0, output: stdout })
      }
    )
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE')
        reject(new ControlledCommitError('controlled_commit_failed', 'Git input failed.'))
    })
    child.stdin?.end(input)
  })

const readCheckoutFile = async (checkout: string, name: string) => {
  if (!name || name.includes('\\') || name.includes('\0') || isAbsolute(name))
    invalid('Invalid Git file path.')
  const parts = name.split('/')
  if (
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        part.toLowerCase() === '.git' ||
        part.includes(':')
    )
  ) {
    invalid('A Git path leaves the allowed worktree.')
  }
  let parent = checkout
  try {
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part)
      const actual = await realDirectory(parent)
      if (!samePath(actual, parent) || !contained(checkout, actual))
        invalid('A file parent leaves the worktree.')
    }
    const path = join(checkout, ...parts)
    const before = await regularFile(path)
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = await handle.stat()
      if (opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1)
        conflict('A checkout file changed while opening it.')
      if (
        process.platform === 'linux' &&
        !contained(checkout, await realpath(`/proc/self/fd/${handle.fd}`))
      ) {
        invalid('The opened file leaves the worktree.')
      }
      const content = await handle.readFile()
      const after = await regularFile(path)
      if (
        after.ino !== opened.ino ||
        after.dev !== opened.dev ||
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs ||
        !samePath(await realpath(path), path)
      ) {
        conflict('A checkout file changed while reading it. Retry after editing stops.')
      }
      return { content, executable: (opened.mode & 0o111) !== 0 }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

/** A local-only commit: no add/commit porcelain, user hooks, filters, or remote operations. */
export const commitRestrictedWorkerChanges = async (
  input: RestrictedWorkerCommitInput
): Promise<RestrictedWorkerCommitResult> => {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.expectedHead))
    conflict('A full expected HEAD is required.')
  if (!input.message.trim() || input.message.length > 10_000 || input.message.includes('\0'))
    conflict('A commit message of at most 10000 characters is required.')
  const layout = await inspectCheckout(input)
  const temporary = await mkdtemp(join(tmpdir(), 'hive-controlled-git-'))
  const indexLockPath = join(layout.gitDir, 'index.lock')
  let indexLock: Awaited<ReturnType<typeof open>> | undefined
  let lockIdentity: Awaited<ReturnType<typeof regularFile>> | undefined
  let installed = false
  let committed: RestrictedWorkerCommitResult | undefined
  const cleanup = async () => {
    try {
      if (indexLock) {
        await indexLock.close()
        if (!installed && lockIdentity) {
          try {
            const current = await regularFile(indexLockPath)
            if (current.ino !== lockIdentity.ino || current.dev !== lockIdentity.dev)
              invalid('The index lock was replaced during cleanup.')
            await rm(indexLockPath)
          } catch (error) {
            if (errorCode(error) !== 'ENOENT') throw error
          }
        }
      }
      if (!resolve(temporary).startsWith(`${resolve(tmpdir())}${sep}hive-controlled-git-`)) {
        throw new ControlledCommitError(
          'controlled_commit_failed',
          'Unexpected temporary Git path.'
        )
      }
      await rm(temporary, { recursive: true, force: true })
    } catch (error) {
      if (!committed) throw error
      committed.temporary_cleanup_required = true
    }
  }
  try {
    const denied = (input.deniedPaths ?? []).map((path) => {
      const absolute = resolve(input.checkoutPath, path)
      return contained(resolve(input.checkoutPath), absolute)
        ? resolve(layout.checkout, relative(resolve(input.checkoutPath), absolute))
        : absolute
    })
    const pathDenied = (path: string) =>
      denied.some((root) => samePath(root, path) || contained(root, path))
    if (pathDenied(layout.checkout))
      invalid('The execution policy does not allow committing this checkout.')
    const executable = await trustedGit([layout.checkout, await realpath(input.repoRoot)])
    const hooks = join(temporary, 'empty-hooks')
    await mkdir(hooks)
    const config = join(temporary, 'empty-config')
    const configFile = await open(config, 'wx')
    await configFile.close()
    const safeArgs = [
      '-c',
      `core.hooksPath=${hooks}`,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'protocol.allow=never',
      '-c',
      'credential.helper=',
      '-c',
      'gc.auto=0',
      '-c',
      'maintenance.auto=false',
    ]
    const env: NodeJS.ProcessEnv = {
      ...baseEnvironment(),
      HOME: temporary,
      XDG_CONFIG_HOME: temporary,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_SYSTEM: config,
      GIT_ATTR_NOSYSTEM: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_NO_LAZY_FETCH: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
    }
    const original = async (args: string[]) =>
      runGit(executable, temporary, env, [
        ...safeArgs,
        `--git-dir=${layout.gitDir}`,
        `--work-tree=${layout.checkout}`,
        ...args,
      ])
    const checked = async (result: Promise<{ status: number; output: Buffer }>) => {
      const value = await result
      if (value.status !== 0)
        throw new ControlledCommitError(
          'controlled_commit_failed',
          'The controlled Git operation failed; no branch was updated.'
        )
      return value.output
    }
    if ((await original(['check-ref-format', `refs/heads/${input.branch}`])).status !== 0)
      invalid('Invalid worker branch.')
    const inspectRefs = async () => {
      const parts = ['refs', 'heads', ...input.branch.split('/')]
      await inspectRefPath(layout.common, parts)
      await inspectRefPath(layout.common, ['logs', ...parts])
      await inspectRefPath(layout.gitDir, ['logs', 'HEAD'])
    }
    await inspectRefs()
    const head = async () =>
      (
        await checked(
          original(['rev-parse', '--verify', '--end-of-options', `refs/heads/${input.branch}`])
        )
      )
        .toString()
        .trim()
    if ((await head()) !== input.expectedHead.toLowerCase())
      conflict('HEAD changed. Refresh before committing.')

    // Read identity only. Other operations use the isolated Git configuration.
    const identityEnv = { ...env }
    for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME']) {
      if (process.env[key]) identityEnv[key] = process.env[key]
      else delete identityEnv[key]
    }
    delete identityEnv.GIT_CONFIG_GLOBAL
    const identity = async (key: string) => {
      const value = await runGit(executable, temporary, identityEnv, [
        ...safeArgs,
        `--git-dir=${layout.gitDir}`,
        'config',
        '--get',
        key,
      ])
      const text = value.output.toString().trim()
      if (value.status !== 0 || !text || text.length > 300 || /[<>\r\n\0]/.test(text)) {
        throw new ControlledCommitError(
          'controlled_commit_identity_required',
          'Configure Git user.name and user.email locally before committing.'
        )
      }
      return text
    }
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = await identity('user.name')
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = await identity('user.email')
    const isolatedGit = join(temporary, 'git')
    await checked(
      runGit(executable, temporary, env, [
        ...safeArgs,
        'init',
        '--bare',
        `--template=${hooks}`,
        `--object-format=${input.expectedHead.length === 64 ? 'sha256' : 'sha1'}`,
        isolatedGit,
      ])
    )
    env.GIT_DIR = isolatedGit
    env.GIT_WORK_TREE = layout.checkout
    env.GIT_OBJECT_DIRECTORY = layout.objects
    env.GIT_INDEX_FILE = join(temporary, 'index')
    const isolated = (args: string[], content?: Buffer | string) =>
      checked(
        runGit(executable, temporary, env, [...safeArgs, '-c', 'core.bare=false', ...args], content)
      )
    const baseline = await isolated(['ls-tree', '-rz', '--full-tree', input.expectedHead])
    if (!Buffer.from(baseline.toString()).equals(baseline))
      invalid('Git paths must use valid UTF-8.')
    const entries = new Map<string, string>()
    for (const entry of baseline.toString().split('\0').filter(Boolean)) {
      const match = /^(100644|100755) blob [a-f0-9]+\t([\s\S]+)$/.exec(entry)
      if (!match?.[1] || !match[2])
        return invalid('Controlled commits do not support symlinks or submodules.')
      entries.set(match[2], match[1])
    }
    await isolated(['read-tree', input.expectedHead])
    const exclusions = denied
      .filter((path) => contained(layout.checkout, path))
      .flatMap((path) => {
        const pattern = relative(layout.checkout, path)
          .replaceAll('\\', '/')
          .replace(/[?*[\]]/g, '\\$&')
        return [`--exclude=/${pattern}`, `--exclude=/${pattern}/**`]
      })
    const untrackedOutput = await isolated([
      'ls-files',
      '--others',
      '--exclude-standard',
      ...exclusions,
      '-z',
    ])
    if (!Buffer.from(untrackedOutput.toString()).equals(untrackedOutput))
      invalid('Git paths must use valid UTF-8.')
    const untracked = untrackedOutput.toString().split('\0').filter(Boolean)
    for (const name of untracked) if (!entries.has(name)) entries.set(name, '100644')
    let originalIndex: Awaited<ReturnType<typeof regularFile>> | undefined
    try {
      originalIndex = await regularFile(join(layout.gitDir, 'index'))
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
    try {
      indexLock = await open(indexLockPath, 'wx', 0o600)
      lockIdentity = await indexLock.stat()
    } catch (error) {
      if (errorCode(error) === 'EEXIST')
        conflict('Another Git operation holds the worktree index lock.')
      throw error
    }
    const updates: string[] = []
    const snapshots: Array<{ name: string; mode: string; path: string }> = []
    const snapshotDir = join(temporary, 'files')
    await mkdir(snapshotDir)
    for (const [name, previousMode] of entries) {
      if (name === '.hive' || name.startsWith('.hive/')) continue
      // Preserve an existing tree entry without reading the current denied file.
      // Runtime credentials must not become readable through a new Git blob.
      if (pathDenied(resolve(layout.checkout, name))) continue
      const file = await readCheckoutFile(layout.checkout, name)
      if (!file) {
        updates.push(`0 ${'0'.repeat(input.expectedHead.length)}\t${name}\0`)
        continue
      }
      const mode =
        process.platform === 'win32' ? previousMode : file.executable ? '100755' : '100644'
      const path = join(snapshotDir, String(snapshots.length))
      await writeFile(path, file.content, { mode: 0o600, flag: 'wx' })
      snapshots.push({ name, mode, path })
    }
    const blobs = snapshots.length
      ? (
          await isolated(
            ['hash-object', '-w', '--stdin-paths', '--no-filters'],
            snapshots.map(({ path }) => JSON.stringify(path.replaceAll('\\', '/'))).join('\n') +
              '\n'
          )
        )
          .toString()
          .trim()
          .split(/\r?\n/)
      : []
    if (blobs.length !== snapshots.length)
      throw new ControlledCommitError(
        'controlled_commit_failed',
        'Git did not hash every checkout file.'
      )
    snapshots.forEach(({ mode, name }, index) => {
      updates.push(`${mode} ${blobs[index]}\t${name}\0`)
    })
    await isolated(['update-index', '-z', '--index-info'], updates.join(''))
    const tree = (await isolated(['write-tree'])).toString().trim()
    const oldTree = (await isolated(['rev-parse', `${input.expectedHead}^{tree}`]))
      .toString()
      .trim()
    if (tree === oldTree) conflict('There are no worktree file changes to commit.')
    const commitSha = (
      await isolated(['commit-tree', tree, '-p', input.expectedHead], `${input.message.trim()}\n`)
    )
      .toString()
      .trim()
    await indexLock.writeFile(await readFile(env.GIT_INDEX_FILE))
    await indexLock.sync()
    await indexLock.close()
    const finalLayout = await inspectCheckout(input)
    if (
      !samePath(finalLayout.gitDir, layout.gitDir) ||
      !samePath(finalLayout.checkout, layout.checkout)
    )
      conflict('The registered worktree changed while committing.')
    const preparedIndex = await regularFile(indexLockPath)
    if (
      !samePath(await realpath(indexLockPath), indexLockPath) ||
      preparedIndex.size === 0 ||
      !lockIdentity ||
      preparedIndex.ino !== lockIdentity.ino ||
      preparedIndex.dev !== lockIdentity.dev
    ) {
      invalid('The prepared Git index was replaced.')
    }
    try {
      const currentIndex = await regularFile(join(layout.gitDir, 'index'))
      if (
        !originalIndex ||
        currentIndex.ino !== originalIndex.ino ||
        currentIndex.dev !== originalIndex.dev ||
        currentIndex.size !== originalIndex.size ||
        currentIndex.mtimeMs !== originalIndex.mtimeMs ||
        currentIndex.ctimeMs !== originalIndex.ctimeMs
      ) {
        conflict('The worktree index changed while committing.')
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
      if (originalIndex) conflict('The worktree index disappeared while committing.')
    }
    // Unset isolated plumbing variables before the one permitted ref write.
    await inspectRefs()
    const refEnv = { ...env }
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY', 'GIT_INDEX_FILE'])
      delete refEnv[key]
    const updated = await runGit(executable, temporary, refEnv, [
      ...safeArgs,
      `--git-dir=${layout.gitDir}`,
      'update-ref',
      '--no-deref',
      `refs/heads/${input.branch}`,
      commitSha,
      input.expectedHead,
    ])
    if (updated.status !== 0)
      conflict('The branch changed or its ref could not be locked. No commit was published.')
    committed = {
      committed: true,
      commit_sha: commitSha,
      parent_sha: input.expectedHead,
      branch: input.branch,
    }
    try {
      await rename(indexLockPath, join(layout.gitDir, 'index'))
      installed = true
      return committed
    } catch {
      // The ref CAS is the commit point. Never pretend it failed or roll it back.
      committed.index_sync_required = true
      return committed
    }
  } finally {
    await cleanup()
  }
}
