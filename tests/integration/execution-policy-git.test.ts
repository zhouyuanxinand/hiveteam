import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { commitRestrictedWorkerChanges } from '../../src/server/execution-policy-git.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []
const renameFailure = vi.hoisted(() => ({ path: '' }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    rename: async (from: string, to: string) => {
      if (to === renameFailure.path)
        throw Object.assign(new Error('Synthetic index access denial'), { code: 'EACCES' })
      return fs.rename(from, to)
    },
  }
})

afterEach(async () => {
  renameFailure.path = ''
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}hive-controlled-commit-test-`))
      throw new Error('Unexpected cleanup path')
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

const git = async (cwd: string, args: string[]) =>
  (
    await execFileAsync(
      'git',
      ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args],
      {
        cwd,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
        windowsHide: true,
      }
    )
  ).stdout.trim()

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'hive-controlled-commit-test-'))
  roots.push(root)
  const repo = join(root, 'repository')
  const checkout = join(root, 'worker 中文')
  const home = join(root, 'home')
  await mkdir(repo)
  await mkdir(home)
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.stubEnv('XDG_CONFIG_HOME', home)
  await writeFile(
    join(home, '.gitconfig'),
    '[user]\nname = Test User\nemail = test@example.invalid\n'
  )
  await git(repo, ['init', '-b', 'main'])
  await writeFile(join(repo, 'value.txt'), 'original\n')
  await writeFile(join(repo, 'deleted.txt'), 'remove me\n')
  await writeFile(join(repo, '.gitignore'), '*.ignored\n.hive/\n')
  await git(repo, ['add', '.'])
  await git(repo, ['commit', '-m', 'Initial files'])
  const head = await git(repo, ['rev-parse', 'HEAD'])
  await git(repo, ['branch', 'other'])
  await git(repo, ['worktree', 'add', '-b', 'hive/worker-test', checkout, head])
  const gitDir = (await git(checkout, ['rev-parse', '--absolute-git-dir'])).replaceAll('/', sep)
  const input = {
    checkoutPath: checkout,
    repoRoot: repo,
    branch: 'hive/worker-test',
    expectedHead: head,
    message: 'Update worker files',
  }
  return { root, repo, checkout, head, gitDir, input }
}

describe('controlled worker Git commit', () => {
  test('commits dirty worker files, leaves other refs and main checkout intact, and installs a clean index', async () => {
    const fixture = await setup()
    await writeFile(join(fixture.repo, 'value.txt'), 'main checkout must not be committed\n')
    await writeFile(join(fixture.checkout, 'value.txt'), 'worker value\n')
    await writeFile(join(fixture.checkout, '新增.txt'), 'new worker file\n')
    await writeFile(join(fixture.checkout, 'local.ignored'), 'ignored\n')
    await rm(join(fixture.checkout, 'deleted.txt'))
    const result = await commitRestrictedWorkerChanges(fixture.input)
    expect(result).toMatchObject({ parent_sha: fixture.head, branch: fixture.input.branch })
    expect(result.index_sync_required).toBeUndefined()
    expect(await git(fixture.checkout, ['rev-parse', 'HEAD'])).toBe(result.commit_sha)
    expect(await git(fixture.checkout, ['rev-parse', 'HEAD^'])).toBe(fixture.head)
    expect(await git(fixture.repo, ['rev-parse', 'main'])).toBe(fixture.head)
    expect(await git(fixture.repo, ['rev-parse', 'other'])).toBe(fixture.head)
    expect(await git(fixture.checkout, ['show', 'HEAD:value.txt'])).toBe('worker value')
    expect(await git(fixture.checkout, ['show', 'HEAD:新增.txt'])).toBe('new worker file')
    expect(await git(fixture.checkout, ['ls-tree', '--name-only', 'HEAD'])).not.toContain(
      'deleted.txt'
    )
    expect(await git(fixture.checkout, ['status', '--porcelain'])).toBe('')
    expect(await readFile(join(fixture.repo, 'value.txt'), 'utf8')).toBe(
      'main checkout must not be committed\n'
    )
  })

  test('never executes hooks, clean filters, fsmonitor, signing or credentials configured by the project', async () => {
    const fixture = await setup()
    const sentinel = join(fixture.root, 'executed.txt')
    const hookDir = join(fixture.root, 'hooks')
    await mkdir(hookDir)
    const script = `#!/bin/sh\nprintf '%s' "$HIVE_SUPERVISOR_TOKEN" >> '${sentinel.replaceAll('\\', '/')}'\nexit 17\n`
    for (const name of ['pre-commit', 'commit-msg', 'post-commit', 'reference-transaction']) {
      await writeFile(join(hookDir, name), script)
      await chmod(join(hookDir, name), 0o755)
    }
    const program = join(hookDir, 'pre-commit').replaceAll('\\', '/')
    for (const [key, value] of [
      ['core.hooksPath', hookDir],
      ['core.fsmonitor', program],
      ['filter.malicious.clean', `'${program}'`],
      ['filter.malicious.required', 'true'],
      ['commit.gpgsign', 'true'],
      ['gpg.program', program],
      ['credential.helper', `! '${program}'`],
    ])
      await git(fixture.repo, ['config', key ?? '', value ?? ''])
    await writeFile(join(fixture.checkout, '.gitattributes'), '*.txt filter=malicious\n')
    await writeFile(join(fixture.checkout, 'value.txt'), 'raw bytes\r\n')
    vi.stubEnv('HIVE_SUPERVISOR_TOKEN', 'synthetic-secret-marker')
    vi.stubEnv('GIT_CONFIG_COUNT', '1')
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.fsmonitor')
    vi.stubEnv('GIT_CONFIG_VALUE_0', program)
    const result = await commitRestrictedWorkerChanges(fixture.input)
    expect(existsSync(sentinel)).toBe(false)
    expect(await git(fixture.checkout, ['rev-parse', 'HEAD'])).toBe(result.commit_sha)
    expect(
      (await execFileAsync('git', ['show', 'HEAD:value.txt'], { cwd: fixture.checkout })).stdout
    ).toBe('raw bytes\r\n')
    expect(await git(fixture.repo, ['rev-parse', 'main'])).toBe(fixture.head)
    expect(existsSync(sentinel)).toBe(false)
  })

  test('a stale expected HEAD or wrong branch does not alter refs or the existing index', async () => {
    const fixture = await setup()
    await writeFile(join(fixture.checkout, 'value.txt'), 'first\n')
    const first = await commitRestrictedWorkerChanges(fixture.input)
    await writeFile(join(fixture.checkout, 'value.txt'), 'second\n')
    const index = await readFile(join(fixture.gitDir, 'index'))
    await expect(commitRestrictedWorkerChanges(fixture.input)).rejects.toMatchObject({
      code: 'controlled_commit_conflict',
    })
    await expect(
      commitRestrictedWorkerChanges({
        ...fixture.input,
        branch: 'main',
        expectedHead: first.commit_sha,
      })
    ).rejects.toMatchObject({ code: 'controlled_commit_conflict' })
    expect(await git(fixture.checkout, ['rev-parse', 'HEAD'])).toBe(first.commit_sha)
    expect(await readFile(join(fixture.gitDir, 'index'))).toEqual(index)
    expect(existsSync(join(fixture.gitDir, 'index.lock'))).toBe(false)
  })

  test('refuses a substituted checkout and a directory link to files outside the worktree', async () => {
    const fixture = await setup()
    const alias = join(fixture.root, 'alias')
    await symlink(fixture.checkout, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(
      commitRestrictedWorkerChanges({ ...fixture.input, checkoutPath: alias })
    ).rejects.toMatchObject({ code: 'controlled_commit_invalid_checkout' })
    await expect(
      commitRestrictedWorkerChanges({ ...fixture.input, checkoutPath: fixture.repo })
    ).rejects.toMatchObject({ code: 'controlled_commit_invalid_checkout' })
    const outside = join(fixture.root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'private.txt'), 'not a workspace file')
    await symlink(
      outside,
      join(fixture.checkout, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await expect(commitRestrictedWorkerChanges(fixture.input)).rejects.toMatchObject({
      code: 'controlled_commit_invalid_checkout',
    })
    expect(await git(fixture.checkout, ['rev-parse', 'HEAD'])).toBe(fixture.head)
    expect(existsSync(join(fixture.gitDir, 'index.lock'))).toBe(false)
  })

  test('the final ref CAS preserves another writer that advances the branch during snapshot preparation', async () => {
    const fixture = await setup()
    await Promise.all(
      Array.from({ length: 250 }, async (_, index) => {
        await writeFile(join(fixture.checkout, `new-${index}.txt`), `worker file ${index}\n`)
      })
    )
    const tree = await git(fixture.repo, ['rev-parse', `${fixture.head}^{tree}`])
    const external = await git(fixture.repo, [
      'commit-tree',
      tree,
      '-p',
      fixture.head,
      '-m',
      'Concurrent local change',
    ])
    const index = await readFile(join(fixture.gitDir, 'index'))
    const pending = commitRestrictedWorkerChanges(fixture.input)
    const observed = pending.then(
      (result) => ({ result, error: null }),
      (error: unknown) => ({ result: null, error })
    )
    await expect
      .poll(() => existsSync(join(fixture.gitDir, 'index.lock')), { timeout: 15_000, interval: 5 })
      .toBe(true)
    await git(fixture.repo, [
      'update-ref',
      `refs/heads/${fixture.input.branch}`,
      external,
      fixture.head,
    ])
    expect((await observed).error).toMatchObject({ code: 'controlled_commit_conflict' })
    expect(await git(fixture.checkout, ['rev-parse', 'HEAD'])).toBe(external)
    expect(await readFile(join(fixture.gitDir, 'index'))).toEqual(index)
    expect(await git(fixture.repo, ['rev-parse', 'main'])).toBe(fixture.head)
  })

  test('refuses hard-linked files without committing their contents', async () => {
    const fixture = await setup()
    const outside = join(fixture.root, 'outside.txt')
    await writeFile(outside, 'private hard-linked content')
    await link(outside, join(fixture.checkout, 'linked.txt'))
    await expect(commitRestrictedWorkerChanges(fixture.input)).rejects.toMatchObject({
      code: 'controlled_commit_invalid_checkout',
    })
    expect(await git(fixture.checkout, ['rev-parse', 'HEAD'])).toBe(fixture.head)
  })

  test('denied credential files remain outside newly written Git objects, including tracked denied files', async () => {
    const fixture = await setup()
    await writeFile(join(fixture.checkout, '.env'), 'historical fixture value\n')
    await git(fixture.checkout, ['add', '.env'])
    await git(fixture.checkout, ['commit', '-m', 'Historical fixture'])
    const expectedHead = await git(fixture.checkout, ['rev-parse', 'HEAD'])
    const deniedContent = 'synthetic-runtime-secret-that-must-not-enter-git\n'
    await writeFile(join(fixture.checkout, '.env'), deniedContent)
    const privateDir = join(fixture.checkout, 'private-runtime')
    await mkdir(privateDir)
    await writeFile(join(privateDir, 'auth.json'), deniedContent)
    await writeFile(join(fixture.checkout, 'value.txt'), 'allowed worker change\n')
    const result = await commitRestrictedWorkerChanges({
      ...fixture.input,
      expectedHead,
      deniedPaths: ['.env', privateDir],
    })
    expect(result.committed).toBe(true)
    expect(await git(fixture.checkout, ['show', 'HEAD:.env'])).toBe('historical fixture value')
    expect(await git(fixture.checkout, ['ls-tree', '-r', '--name-only', 'HEAD'])).not.toContain(
      'private-runtime'
    )
    const blob = createHash('sha1')
      .update(`blob ${Buffer.byteLength(deniedContent)}\0`)
      .update(deniedContent)
      .digest('hex')
    await expect(git(fixture.checkout, ['cat-file', '-e', blob])).rejects.toMatchObject({ code: 1 })
    expect(await readFile(join(fixture.checkout, '.env'), 'utf8')).toBe(deniedContent)
  })

  test('a post-CAS index installation failure reports the published commit instead of rolling back its ref', async () => {
    const fixture = await setup()
    const originalIndex = await readFile(join(fixture.gitDir, 'index'))
    await writeFile(
      join(fixture.checkout, 'value.txt'),
      'published despite an index access failure\n'
    )
    renameFailure.path = join(await realpath(fixture.gitDir), 'index')
    const result = await commitRestrictedWorkerChanges(fixture.input)
    expect(result.index_sync_required).toBe(true)
    expect(await git(fixture.checkout, ['rev-parse', 'HEAD'])).toBe(result.commit_sha)
    expect(await git(fixture.checkout, ['show', 'HEAD:value.txt'])).toBe(
      'published despite an index access failure'
    )
    expect(await readFile(join(fixture.gitDir, 'index'))).toEqual(originalIndex)
    expect(await git(fixture.repo, ['rev-parse', 'main'])).toBe(fixture.head)
    expect(existsSync(join(fixture.gitDir, 'index.lock'))).toBe(false)
  })
})
