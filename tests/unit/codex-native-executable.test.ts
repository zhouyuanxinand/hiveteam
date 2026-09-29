import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { prepareCodexInitialPrompt } from '../../src/server/codex-initial-prompt.js'
import { resolveCodexNativeExecutable } from '../../src/server/codex-native-executable.js'
import { readExecutionCliIdentity } from '../../src/server/execution-cli-identity.js'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

const layouts = ['global-nested', 'local-hoisted', 'pnpm-linked'] as const
const fixture = async (layout: (typeof layouts)[number]) => {
  const root = await mkdtemp(join(tmpdir(), 'hive-codex-layout-'))
  directories.push(root)
  const modules = join(root, 'node_modules')
  const visiblePackage = join(modules, '@openai', 'codex')
  const packageRoot =
    layout === 'pnpm-linked'
      ? join(modules, '.pnpm', 'codex@fixture', 'node_modules', '@openai', 'codex')
      : visiblePackage
  const launcher = join(layout === 'global-nested' ? root : join(modules, '.bin'), 'codex.cmd')
  const nativePackageName = `codex-${process.platform}-${process.arch}`
  const visibleNativePackage =
    layout === 'global-nested'
      ? join(packageRoot, 'node_modules', '@openai', nativePackageName)
      : join(dirname(packageRoot), nativePackageName)
  const nativePackage =
    layout === 'pnpm-linked'
      ? join(
          modules,
          '.pnpm',
          `${nativePackageName}@fixture`,
          'node_modules',
          '@openai',
          nativePackageName
        )
      : visibleNativePackage
  const cpu = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  const system =
    process.platform === 'win32'
      ? 'pc-windows-msvc'
      : process.platform === 'darwin'
        ? 'apple-darwin'
        : 'unknown-linux-musl'
  const native = join(
    nativePackage,
    'vendor',
    `${cpu}-${system}`,
    'bin',
    process.platform === 'win32' ? 'codex.exe' : 'codex'
  )
  await mkdir(dirname(launcher), { recursive: true })
  await mkdir(join(packageRoot, 'bin'), { recursive: true })
  await mkdir(dirname(native), { recursive: true })
  if (layout === 'pnpm-linked') {
    await mkdir(dirname(visiblePackage), { recursive: true })
    await symlink(packageRoot, visiblePackage, 'junction')
    await symlink(nativePackage, visibleNativePackage, 'junction')
  }
  await writeFile(join(packageRoot, 'package.json'), '{"name":"@openai/codex"}')
  await writeFile(
    join(nativePackage, 'package.json'),
    JSON.stringify({ name: `@openai/${nativePackageName}` })
  )
  const jsLauncher = join(visiblePackage, 'bin', 'codex.js')
  await writeFile(jsLauncher, '// Synthetic launcher; resolution never executes it.', {
    mode: 0o700,
  })
  const relativeLauncher =
    layout === 'global-nested' ? 'node_modules\\@openai\\codex' : '..\\@openai\\codex'
  await writeFile(launcher, `@echo off\r\nnode "%~dp0${relativeLauncher}\\bin\\codex.js" %*\r\n`, {
    mode: 0o700,
  })
  const nativeBytes = 'Synthetic native artifact; resolution never executes it.'
  await writeFile(native, nativeBytes, { mode: 0o700 })
  return { root, launcher, jsLauncher, native, nativeBytes }
}

test.each(
  layouts
)('resolves the same native artifact for %s shim and real Node entry', async (layout) => {
  const f = await fixture(layout)
  const expected = await realpath(f.native)
  for (const command of [f.launcher, f.jsLauncher, await realpath(f.jsLauncher)]) {
    expect(await resolveCodexNativeExecutable(command)).toBe(expected)
    const identity = await readExecutionCliIdentity({ command, commandPresetId: 'codex' }, f.root)
    expect(identity).toMatchObject({
      available: true,
      executable: expected,
      artifactSha256: createHash('sha256').update(f.nativeBytes).digest('hex'),
      version: null,
    })
  }
})

test.skipIf(process.platform !== 'win32').each(layouts)(
  'Windows initial prompt uses the exact identity-checked %s artifact',
  async (layout) => {
    const f = await fixture(layout)
    const config = { command: f.launcher, commandPresetId: 'codex', args: ['--no-daemon'] }
    const identity = await readExecutionCliIdentity(config, f.root)
    const text = '完整启动说明\n"quotes" & %PATH% 🐝'
    const prepared = await prepareCodexInitialPrompt(config, f.root, process.env, text)
    expect(prepared).toEqual({ command: identity.executable, args: ['--no-daemon', '--', text] })
  }
)

test('missing native binaries retain the shim and reject initial-prompt handoff', async () => {
  const f = await fixture('local-hoisted')
  await rm(f.native)
  expect(await resolveCodexNativeExecutable(f.launcher)).toBe(await realpath(f.launcher))
  await expect(
    prepareCodexInitialPrompt({ command: f.launcher }, f.root, process.env, '完整\n启动说明')
  ).rejects.toThrow('shell wrapper cannot safely receive a multiline initial prompt')
})
