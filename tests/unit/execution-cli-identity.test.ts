import { mkdir, mkdtemp, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import { resolveCodexNativeExecutable } from '../../src/server/codex-native-executable.js'
import { readExecutionCliIdentity } from '../../src/server/execution-cli-identity.js'

test('launcher and native upgrades each invalidate the CLI fingerprint even with restored mtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hive-cli-identity-'))
  try {
    const windows = process.platform === 'win32'
    const wrapper = join(root, windows ? 'codex.cmd' : 'codex.js')
    const packageRoot = windows ? join(root, 'node_modules', '@openai', 'codex') : root
    const launcher = windows ? wrapper : join(root, 'bin', 'codex.js')
    await mkdir(join(root, 'bin'), { recursive: true })
    const target = officialTargets.find(
      (item) => item.platform === process.platform && item.arch === process.arch
    )?.target
    if (!target) throw new Error('Unsupported test platform')
    const nativeRoot = join(
      packageRoot,
      'node_modules',
      '@openai',
      `codex-${windows ? 'win32' : process.platform}-${process.arch}`,
      'vendor',
      target,
      'bin'
    )
    await mkdir(nativeRoot, { recursive: true })
    await writeFile(join(dirname(dirname(dirname(nativeRoot))), 'package.json'), '{}')
    const native = join(nativeRoot, windows ? 'codex.exe' : 'codex')
    await writeFile(native, 'synthetic immutable native bytes', { mode: 0o700 })
    await writeFile(launcher, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    const before = await readExecutionCliIdentity({ command: launcher }, root)
    expect(before.launcher).toBe(await realpath(launcher))
    expect(before.executable).not.toBe(launcher)
    expect(before.version).toBeNull()
    const timestamp = await stat(launcher)
    await writeFile(launcher, '#!/bin/sh\nexit 1\n', { mode: 0o700 })
    await utimes(launcher, timestamp.atime, timestamp.mtime)
    const after = await readExecutionCliIdentity({ command: launcher }, root)
    expect(after.executable).toBe(before.executable)
    expect(after.fingerprint).not.toBe(before.fingerprint)
    expect(after.artifactFingerprint).not.toBe(before.artifactFingerprint)
    const nativeTimestamp = await stat(native)
    await writeFile(native, 'upgraded synthetic native bytes', { mode: 0o700 })
    await utimes(native, nativeTimestamp.atime, nativeTimestamp.mtime)
    const upgraded = await readExecutionCliIdentity({ command: launcher }, root)
    expect(upgraded.launcher).toBe(after.launcher)
    expect(upgraded.executable).toBe(await realpath(native))
    expect(upgraded.artifactSha256).not.toBe(after.artifactSha256)
    expect(upgraded.fingerprint).not.toBe(after.fingerprint)
    expect(upgraded.artifactFingerprint).not.toBe(after.artifactFingerprint)
    expect(upgraded.version).toBeNull()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const officialTargets = [
  { platform: 'darwin', arch: 'x64', target: 'x86_64-apple-darwin' },
  { platform: 'darwin', arch: 'arm64', target: 'aarch64-apple-darwin' },
  { platform: 'win32', arch: 'x64', target: 'x86_64-pc-windows-msvc' },
  { platform: 'win32', arch: 'arm64', target: 'aarch64-pc-windows-msvc' },
  { platform: 'linux', arch: 'x64', target: 'x86_64-unknown-linux-musl' },
  { platform: 'linux', arch: 'arm64', target: 'aarch64-unknown-linux-musl' },
] as const

test.each(
  officialTargets
)('resolves the actual $platform/$arch native artifact behind an npm launcher', async ({
  platform,
  arch,
  target,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'hive-native-artifact-'))
  try {
    const windows = platform === 'win32'
    const launcher = windows ? join(root, 'codex.cmd') : join(root, 'bin', 'codex.js')
    const packageRoot = windows ? join(root, 'node_modules', '@openai', 'codex') : root
    const nativeRoot = join(
      packageRoot,
      'node_modules',
      '@openai',
      `codex-${platform}-${arch}`,
      'vendor',
      target,
      'bin'
    )
    await mkdir(join(root, 'bin'), { recursive: true })
    await mkdir(nativeRoot, { recursive: true })
    await writeFile(join(dirname(dirname(dirname(nativeRoot))), 'package.json'), '{}')
    const native = join(nativeRoot, windows ? 'codex.exe' : 'codex')
    await writeFile(launcher, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    await writeFile(native, 'synthetic native artifact', { mode: 0o700 })
    expect(await resolveCodexNativeExecutable(launcher, platform, arch)).toBe(
      await realpath(native)
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
