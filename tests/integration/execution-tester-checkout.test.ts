import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, test, vi } from 'vitest'
import { createTesterCheckout } from '../../src/server/execution-tester-checkout.js'

const execute = promisify(execFile)
const roots: string[] = []
const checkouts: Awaited<ReturnType<typeof createTesterCheckout>>[] = []
afterEach(async () => {
  for (const checkout of checkouts.splice(0)) await checkout.close()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}hive-tester-checkout-`))
      throw new Error('Invalid test cleanup directory')
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
const git = async (cwd: string, args: string[]) =>
  (await execute('git', args, { cwd, windowsHide: true })).stdout.trim()
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'hive-tester-checkout-'))
  roots.push(root)
  const source = join(root, 'source')
  const home = join(root, 'home')
  await mkdir(source)
  await mkdir(home)
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.stubEnv('XDG_CONFIG_HOME', home)
  vi.stubEnv('GIT_CONFIG_GLOBAL', join(home, '.gitconfig'))
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  await writeFile(
    join(home, '.gitconfig'),
    '[user]\nname=Tester Fixture\nemail=test@example.invalid\n'
  )
  await git(source, ['init', '-b', 'main'])
  await writeFile(join(source, 'value.txt'), 'committed source\n')
  await writeFile(join(source, '.gitattributes'), '*.txt filter=fixture\n')
  await git(source, ['add', '.'])
  await git(source, ['commit', '-m', 'Initial source'])
  const head = await git(source, ['rev-parse', 'HEAD'])
  const rootPath = join(root, 'policies', 'tester')
  return { root, source, home, head, rootPath }
}

test('a Tester sees one committed SHA, creates isolated artifacts, and resumes at the same fresh checkout path', async () => {
  const fixture = await setup()
  await writeFile(join(fixture.source, 'value.txt'), 'source dirty edit\n')
  await writeFile(join(fixture.source, 'untracked.txt'), 'source only\n')
  const originalIndex = await readFile(join(fixture.source, '.git', 'index'))
  const first = await createTesterCheckout({
    sourcePath: fixture.source,
    rootPath: fixture.rootPath,
  })
  checkouts.push(first)
  expect(first.headSha).toBe(fixture.head)
  expect(await git(first.cwd, ['rev-parse', 'HEAD'])).toBe(fixture.head)
  expect(await readFile(join(first.cwd, 'value.txt'), 'utf8')).toBe('committed source\n')
  await expect(stat(join(first.cwd, 'untracked.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  await writeFile(join(first.cwd, 'value.txt'), 'test mutation\n')
  await writeFile(join(first.cwd, 'test-output.txt'), 'disposable result\n')
  expect(await readFile(join(fixture.source, 'value.txt'), 'utf8')).toBe('source dirty edit\n')
  expect(await readFile(join(fixture.source, '.git', 'index'))).toEqual(originalIndex)
  await expect(
    createTesterCheckout({ sourcePath: fixture.source, rootPath: fixture.rootPath })
  ).rejects.toMatchObject({ code: 'execution_policy_denied' })
  await first.close()
  await expect(stat(fixture.rootPath)).rejects.toMatchObject({ code: 'ENOENT' })
  await git(fixture.source, ['add', 'value.txt'])
  await git(fixture.source, ['commit', '-m', 'Next source version'])
  const second = await createTesterCheckout({
    sourcePath: fixture.source,
    rootPath: fixture.rootPath,
  })
  checkouts.push(second)
  expect(second.cwd).toBe(first.cwd)
  expect(second.headSha).not.toBe(first.headSha)
  expect(second.headSha).toBe(await git(fixture.source, ['rev-parse', 'HEAD']))
  await expect(stat(join(second.cwd, 'test-output.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(second.cwd, 'value.txt'), 'utf8')).toBe('source dirty edit\n')
})

test('repository hooks, smudge filters, fsmonitor and inherited Git commands do not execute', async () => {
  const fixture = await setup()
  const sentinel = join(fixture.root, 'hook-ran')
  const script = join(fixture.root, 'malicious.sh')
  await writeFile(script, `#!/bin/sh\nprintf executed > '${sentinel.replaceAll('\\', '/')}'\ncat\n`)
  await chmod(script, 0o755)
  const command = `sh '${script.replaceAll('\\', '/')}'`
  await git(fixture.source, ['config', 'filter.fixture.smudge', command])
  await git(fixture.source, ['config', 'core.fsmonitor', command])
  await git(fixture.source, ['config', 'core.hooksPath', fixture.root])
  await writeFile(join(fixture.root, 'post-checkout'), await readFile(script))
  await chmod(join(fixture.root, 'post-checkout'), 0o755)
  vi.stubEnv('GIT_CONFIG_COUNT', '1')
  vi.stubEnv('GIT_CONFIG_KEY_0', 'filter.fixture.smudge')
  vi.stubEnv('GIT_CONFIG_VALUE_0', command)
  const checkout = await createTesterCheckout({
    sourcePath: fixture.source,
    rootPath: fixture.rootPath,
  })
  checkouts.push(checkout)
  expect(await readFile(join(checkout.cwd, 'value.txt'), 'utf8')).toBe('committed source\n')
  await expect(stat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('an unsupported symlink tree fails before materialization and removes its owned temporary directories', async () => {
  const fixture = await setup()
  const linkBlob = join(fixture.root, 'link-target')
  await writeFile(linkBlob, '../../outside')
  const sha = await git(fixture.source, ['hash-object', '-w', linkBlob])
  await git(fixture.source, ['update-index', '--add', '--cacheinfo', `120000,${sha},escape`])
  await git(fixture.source, ['commit', '-m', 'Synthetic symlink'])
  const head = await git(fixture.source, ['rev-parse', 'HEAD'])
  await expect(
    createTesterCheckout({ sourcePath: fixture.source, rootPath: fixture.rootPath })
  ).rejects.toThrow('without symlinks or submodules')
  await expect(stat(fixture.rootPath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await git(fixture.source, ['rev-parse', 'HEAD'])).toBe(head)
  expect(await readFile(join(fixture.source, 'value.txt'), 'utf8')).toBe('committed source\n')
})

test('a failing Git object read retains its cause and removes temporary state without touching the source', async () => {
  const fixture = await setup()
  await writeFile(join(fixture.source, '.git', 'HEAD'), `${'1'.repeat(40)}\n`)
  await expect(
    createTesterCheckout({ sourcePath: fixture.source, rootPath: fixture.rootPath })
  ).rejects.toMatchObject({
    code: 'execution_policy_denied',
    cause: expect.objectContaining({ code: 128 }),
  })
  await expect(stat(fixture.rootPath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(fixture.source, 'value.txt'), 'utf8')).toBe('committed source\n')
})

test('a linked-worktree subdirectory keeps its relative CWD and original index unchanged', async () => {
  const fixture = await setup()
  await mkdir(join(fixture.source, 'package'))
  await writeFile(join(fixture.source, 'package', 'test.txt'), 'package test source\n')
  await git(fixture.source, ['add', 'package'])
  await git(fixture.source, ['commit', '-m', 'Package source'])
  const linked = join(fixture.root, 'linked')
  await git(fixture.source, ['worktree', 'add', '-b', 'hive/tester', linked, 'HEAD'])
  const source = join(linked, 'package')
  const metadata = await git(linked, ['rev-parse', '--absolute-git-dir'])
  const before = await readFile(join(metadata, 'index'))
  const checkout = await createTesterCheckout({ sourcePath: source, rootPath: fixture.rootPath })
  checkouts.push(checkout)
  expect(checkout.cwd).toBe(join(checkout.checkoutRoot, 'package'))
  expect(checkout.checkoutReadRoots).toEqual([checkout.checkoutRoot])
  expect(await readFile(join(checkout.cwd, 'test.txt'), 'utf8')).toBe('package test source\n')
  await writeFile(join(checkout.cwd, 'test.txt'), 'temporary test output\n')
  expect(await readFile(join(source, 'test.txt'), 'utf8')).toBe('package test source\n')
  expect(await readFile(join(metadata, 'index'))).toEqual(before)
  expect(await git(checkout.cwd, ['rev-parse', 'HEAD'])).toBe(checkout.headSha)
})
