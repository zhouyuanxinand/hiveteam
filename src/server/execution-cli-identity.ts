import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { resolveCommandPath } from './agent-command-resolver.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import { resolveCodexNativeExecutable } from './codex-native-executable.js'
import { createExecutionEnvironment } from './execution-environment.js'

const identities = new Map<string, { stamp: string; digest: string; version: string | null }>()
// Only byte-verified releases receive a security version. Identity discovery never executes the CLI.
const VERIFIED_CODEX_ARTIFACTS = new Map([
  ['0753dfe1d8b87a52436deb13eb1c549661ef4c84fee2c5aa688385eebeccb761', 'codex-cli 0.155.1'],
  ['eba0f32c976667cb9298efafd98513e823eeda7b576a03ec658bb8be8d336316', 'codex-cli 0.155.1'],
  // Windows x64: bundled-model metadata and fixed login-status probe verified.
  ['af02050cc0c95f5aeb714af2c1077e635c58e9896c13c89d75099cf5b96477be', 'codex-cli 0.158.0'],
])

export interface ExecutionCliIdentity {
  artifactSha256?: string
  artifactFingerprint?: string
  id: string
  executable: string | null
  launcher: string | null
  version: string | null
  fingerprint: string
  available: boolean
  unavailableReason?: string
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
    executable = await resolveCodexNativeExecutable(launcher)
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
  const artifact = [
    executable,
    identity.digest,
    launcher,
    launcher === executable ? identity.digest : await digestFile(launcher),
  ]
  return {
    id: requestedId,
    executable,
    launcher,
    available: true,
    artifactSha256: identity.digest,
    artifactFingerprint: createHash('sha256').update(JSON.stringify(artifact)).digest('hex'),
    version: identity.version,
    fingerprint: createHash('sha256')
      .update(JSON.stringify([...artifact, launchIdentity]))
      .digest('hex'),
  }
}
