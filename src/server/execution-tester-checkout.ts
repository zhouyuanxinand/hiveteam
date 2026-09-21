import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { resolveCommandPath } from './agent-command-resolver.js'
import { readExecutionFilesystem } from './execution-filesystem.js'
import { ExecutionPolicyError } from './execution-policy-error.js'

const execute = promisify(execFile)
const activeRoots = new Set<string>()
const fail = (message: string): never => {
  throw new ExecutionPolicyError(message, ['tester_checkout_unavailable'])
}
const same = (left: string, right: string) =>
  process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
const inside = (root: string, path: string) => {
  const part = relative(root, path)
  return !part || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}
const directory = async (path: string) => {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink())
    fail('Tester checkout directory was redirected.')
  return realpath(path)
}
const readHead = async (gitDirectory: string, commonDirectory: string) => {
  const value = (await readFile(join(gitDirectory, 'HEAD'), 'utf8')).trim()
  if (/^[a-f0-9]{40}$/u.test(value)) return value
  const reference = /^ref: (refs\/[A-Za-z0-9_./-]+)$/u.exec(value)?.[1]
  if (!reference || reference.split('/').some((part) => !part || part === '.' || part === '..'))
    return fail('The Tester source HEAD is not a supported Git reference.')
  let head: string | undefined
  try {
    head = (await readFile(join(commonDirectory, reference), 'utf8')).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    try {
      head = (await readFile(join(commonDirectory, 'packed-refs'), 'utf8'))
        .split('\n')
        .find((line) => line.endsWith(` ${reference}`))
        ?.split(' ')[0]
    } catch (packedError) {
      if ((packedError as NodeJS.ErrnoException).code !== 'ENOENT') throw packedError
    }
  }
  if (!head || !/^[a-f0-9]{40}$/u.test(head))
    return fail('The Tester source has no committed SHA-1 HEAD.')
  return head
}

/** A stable session CWD is rebuilt from one immutable commit for each Tester run. */
export const createTesterCheckout = async (input: {
  sourcePath: string
  rootPath: string
  headSha?: string
}) => {
  const source = await directory(input.sourcePath)
  await mkdir(dirname(resolve(input.rootPath)), { recursive: true, mode: 0o700 })
  const parent = await realpath(dirname(resolve(input.rootPath)))
  const root = join(parent, relative(dirname(resolve(input.rootPath)), resolve(input.rootPath)))
  if (inside(source, root) || inside(root, source))
    fail('Tester checkout and source directories must not overlap.')
  if (activeRoots.has(root)) fail('This Tester checkout is already in use.')
  activeRoots.add(root)
  const markerPath = join(root, 'owner.json')
  let owned = false
  let ownershipId: string | undefined
  const cleanup = async () => {
    if (!owned) return
    if (!same(await directory(root), root) || !inside(parent, root) || same(parent, root))
      fail('Tester cleanup path is outside its runtime directory.')
    const markerInfo = await lstat(markerPath)
    if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.nlink !== 1)
      fail('Tester checkout ownership was redirected.')
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
      purpose?: string
      source?: string
      id?: string
    }
    if (
      marker.purpose !== 'hive-tester-checkout-v1' ||
      marker.source !== source ||
      marker.id !== ownershipId
    )
      fail('Tester checkout ownership changed; cleanup was stopped.')
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    owned = false
  }
  try {
    try {
      await lstat(root)
      if (!same(await directory(root), root)) fail('A previous Tester checkout was redirected.')
      const info = await lstat(markerPath)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
        fail('Tester checkout ownership is missing.')
      const marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
        purpose?: string
        source?: string
        id?: string
      }
      if (
        marker.purpose !== 'hive-tester-checkout-v1' ||
        marker.source !== source ||
        typeof marker.id !== 'string'
      )
        fail('An existing directory is not owned by this Tester checkout.')
      ownershipId = marker.id
      owned = true
      await cleanup()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await mkdir(root, { mode: 0o700 })
    ownershipId = randomUUID()
    await writeFile(
      markerPath,
      JSON.stringify({ purpose: 'hive-tester-checkout-v1', source, id: ownershipId }),
      { flag: 'wx', mode: 0o600 }
    )
    owned = true
    const filesystem = await readExecutionFilesystem(source)
    if (!filesystem.gitDirectory || !filesystem.commonDirectory || !filesystem.worktreeRoot)
      return fail('Tester requires a committed Git source checkout.')
    const headSha =
      input.headSha ?? (await readHead(filesystem.gitDirectory, filesystem.commonDirectory))
    if (!/^[a-f0-9]{40}$/u.test(headSha)) return fail('Tester requires a full SHA-1 commit.')
    const objects = await directory(join(filesystem.commonDirectory, 'objects'))
    if (objects.includes('\n') || objects.includes('\r')) fail('Git object path is not supported.')
    const checkoutRoot = join(root, 'checkout')
    const cwd = resolve(checkoutRoot, relative(filesystem.worktreeRoot, source))
    if (!inside(checkoutRoot, cwd)) fail('The Tester workspace leaves its Git checkout.')
    const metadata = join(root, 'repository')
    const emptyHome = join(root, 'home')
    await mkdir(checkoutRoot)
    await mkdir(emptyHome)
    await mkdir(join(metadata, 'objects', 'info'), { recursive: true })
    await mkdir(join(metadata, 'refs'))
    await mkdir(join(metadata, 'hooks'))
    await writeFile(
      join(metadata, 'config'),
      '[core]\nrepositoryformatversion = 0\nbare = false\nfsmonitor = false\nprotectNTFS = true\nprotectHFS = true\n'
    )
    await writeFile(join(metadata, 'HEAD'), `${headSha}\n`)
    await writeFile(
      join(metadata, 'objects', 'info', 'alternates'),
      `${objects.replaceAll('\\', '/')}\n`
    )
    await writeFile(join(checkoutRoot, '.git'), `gitdir: ${metadata.replaceAll('\\', '/')}\n`)
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
    const env: NodeJS.ProcessEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase()))
    )
    Object.assign(env, {
      HOME: emptyHome,
      XDG_CONFIG_HOME: emptyHome,
      GIT_DIR: metadata,
      GIT_COMMON_DIR: metadata,
      GIT_WORK_TREE: checkoutRoot,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    })
    const git = await realpath(resolveCommandPath('git', parent, env))
    if (inside(source, git) || inside(root, git))
      fail('Tester checkout requires Git outside the mutable checkout.')
    const runGit = async (args: string[]) => {
      try {
        const result = await execute(
          git,
          [
            '-c',
            `core.hooksPath=${join(metadata, 'hooks')}`,
            '-c',
            'core.attributesFile=',
            ...args,
          ],
          {
            cwd: checkoutRoot,
            env,
            encoding: 'buffer',
            maxBuffer: 32 * 1024 * 1024,
            timeout: 60_000,
            windowsHide: true,
          }
        )
        return result.stdout
      } catch (error) {
        const failure = new ExecutionPolicyError(
          'The isolated Tester Git checkout could not be created.',
          ['tester_checkout_unavailable']
        )
        failure.cause = error
        throw failure
      }
    }
    await runGit(['cat-file', '-e', `${headSha}^{commit}`])
    const entries = await runGit(['ls-tree', '-r', '-z', headSha])
    for (const entry of entries.toString('utf8').split('\0').filter(Boolean)) {
      const match = /^(100644|100755) blob [a-f0-9]{40}\t(.+)$/su.exec(entry)
      const name = match?.[2]
      if (
        !name ||
        name.includes('\\') ||
        name
          .split('/')
          .some(
            (part) =>
              !part ||
              part === '.' ||
              part === '..' ||
              part.toLowerCase() === '.git' ||
              part.includes(':')
          )
      )
        fail('Tester snapshots currently require regular Git files without symlinks or submodules.')
    }
    await runGit(['read-tree', headSha])
    // This private Git directory has no repository/global filter, hook, credential
    // or fsmonitor commands. Project attributes cannot install executable filters.
    await runGit(['checkout-index', '--all', '--force'])
    await directory(cwd)
    let closing: Promise<void> | undefined
    return {
      cwd,
      checkoutRoot,
      checkoutReadRoots: same(cwd, checkoutRoot) ? [] : [checkoutRoot],
      headSha,
      sourcePath: source,
      sourceReadRoots: [source, ...filesystem.gitReadRoots],
      sourceDeniedPaths: filesystem.denyPaths,
      close() {
        closing ??= cleanup().finally(() => activeRoots.delete(root))
        return closing
      },
    }
  } catch (error) {
    try {
      await cleanup()
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Tester preparation and checkout cleanup both failed.'
      )
    } finally {
      activeRoots.delete(root)
    }
    throw error
  }
}
