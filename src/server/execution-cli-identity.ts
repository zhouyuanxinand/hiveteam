import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { resolveCommandPath } from './agent-command-resolver.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import { createExecutionEnvironment } from './execution-environment.js'

const identities = new Map<string, { stamp: string; digest: string; version: string | null }>()
// Exact release artifacts, verified with synthetic acceptance only. Unknown bytes never execute a probe.
const VERIFIED_CODEX_ARTIFACTS = new Map([
  ['0753dfe1d8b87a52436deb13eb1c549661ef4c84fee2c5aa688385eebeccb761', 'codex-cli 0.155.1'],
  ['eba0f32c976667cb9298efafd98513e823eeda7b576a03ec658bb8be8d336316', 'codex-cli 0.155.1'],
])

export interface ExecutionCliIdentity {
  artifactSha256?: string
  id: string
  executable: string | null
  launcher: string | null
  version: string | null
  fingerprint: string
  available: boolean
  unavailableReason?: string
}

const nativeCodex = async (path: string) => {
  const name = basename(path).toLowerCase()
  if (name === 'codex' || name === 'codex.exe') return path
  if (!/^codex\.(?:js|cmd|ps1)$/u.test(name)) return path
  const platform = process.platform === 'win32' ? 'win32' : process.platform
  const target =
    process.platform === 'win32'
      ? 'x86_64-pc-windows-msvc'
      : process.arch === 'arm64'
        ? 'aarch64-unknown-linux-musl'
        : 'x86_64-unknown-linux-musl'
  const filename = process.platform === 'win32' ? 'codex.exe' : 'codex'
  const roots =
    name === 'codex.js'
      ? [join(dirname(path), '..')]
      : [join(dirname(path), 'node_modules', '@openai', 'codex')]
  for (const root of roots) {
    const candidate = join(
      root,
      'node_modules',
      '@openai',
      `codex-${platform}-${process.arch}`,
      'vendor',
      target,
      'bin',
      filename
    )
    try {
      await access(candidate)
      return await realpath(candidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return path
}

const digestFile = async (path: string) => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export const readExecutionCliIdentity = async (
  config: AgentLaunchConfigInput,
  cwd: string
): Promise<ExecutionCliIdentity> => {
  const launchIdentity = JSON.stringify({ cwd, config })
  const requestedId = (
    config.commandPresetId ?? basename(config.interactiveCommand ?? config.command)
  )
    .replace(/\.(?:exe|cmd|js|ps1)$/iu, '')
    .toLowerCase()
  let executable: string
  let launcher: string
  try {
    launcher = await realpath(resolveCommandPath(config.command, cwd, createExecutionEnvironment()))
    executable = await nativeCodex(launcher)
  } catch (error) {
    if (!['ENOENT', 'EACCES', 'ENOEXEC'].includes((error as NodeJS.ErrnoException).code ?? ''))
      throw error
    return {
      id: requestedId,
      executable: null,
      launcher: null,
      available: false,
      unavailableReason: (error as NodeJS.ErrnoException).code ?? 'unknown',
      version: null,
      fingerprint: createHash('sha256').update(`unavailable:${launchIdentity}`).digest('hex'),
    }
  }
  const information = await stat(executable)
  const stamp = `${information.dev}:${information.ino}:${information.size}:${information.mtimeMs}:${information.ctimeMs}`
  let identity = identities.get(executable)
  if (identity?.stamp !== stamp) {
    const digest = await digestFile(executable)
    const version =
      VERIFIED_CODEX_ARTIFACTS.get(digest) ??
      (executable === (await realpath(process.execPath)) ? process.version : null)
    identity = { stamp, digest, version }
    identities.set(executable, identity)
  }
  return {
    id: requestedId,
    executable,
    launcher,
    available: true,
    artifactSha256: identity.digest,
    version: identity.version,
    fingerprint: createHash('sha256')
      .update(
        JSON.stringify([
          executable,
          identity.digest,
          launcher,
          launcher === executable ? identity.digest : await digestFile(launcher),
          launchIdentity,
        ])
      )
      .digest('hex'),
  }
}
