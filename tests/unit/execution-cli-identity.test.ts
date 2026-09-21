import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { readExecutionCliIdentity } from '../../src/server/execution-cli-identity.js'

test('launcher bytes remain bound even when a Codex native sibling and saved mtime do not change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hive-cli-identity-'))
  try {
    const windows = process.platform === 'win32'
    const wrapper = join(root, windows ? 'codex.cmd' : 'codex.js')
    const packageRoot = windows ? join(root, 'node_modules', '@openai', 'codex') : root
    const launcher = windows ? wrapper : join(root, 'bin', 'codex.js')
    await mkdir(join(root, 'bin'), { recursive: true })
    const target = windows
      ? 'x86_64-pc-windows-msvc'
      : process.arch === 'arm64'
        ? 'aarch64-unknown-linux-musl'
        : 'x86_64-unknown-linux-musl'
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
    await writeFile(
      join(nativeRoot, windows ? 'codex.exe' : 'codex'),
      'synthetic immutable native bytes',
      { mode: 0o700 }
    )
    await writeFile(launcher, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    const before = await readExecutionCliIdentity({ command: launcher }, root)
    expect(before.launcher).toBe(launcher)
    expect(before.executable).not.toBe(launcher)
    expect(before.version).toBeNull()
    const timestamp = await stat(launcher)
    await writeFile(launcher, '#!/bin/sh\nexit 1\n', { mode: 0o700 })
    await utimes(launcher, timestamp.atime, timestamp.mtime)
    const after = await readExecutionCliIdentity({ command: launcher }, root)
    expect(after.executable).toBe(before.executable)
    expect(after.fingerprint).not.toBe(before.fingerprint)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
