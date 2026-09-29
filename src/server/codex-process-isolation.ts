import { basename } from 'node:path'
import { resolveCommandPath } from './agent-command-resolver.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { ExecutionCliIdentity } from './execution-cli-identity.js'
import { ExecutionPolicyError } from './execution-policy-error.js'
import { runNativeSessionProcess } from './native-session-process.js'

type ProbeContext = Pick<
  Parameters<typeof runNativeSessionProcess>[0],
  'cwd' | 'env' | 'execution' | 'assertPolicy'
>
type CodexIdentity = Pick<
  ExecutionCliIdentity,
  'id' | 'version' | 'executable' | 'launcher' | 'fingerprint'
>
const capabilities = new Map<string, boolean>()

/** Capability discovery runs only after execution authorization, never during preview.
 * It does not certify the executable or widen the restricted execution allowlist. */
export const withCodexProcessIsolation = async (
  config: AgentLaunchConfigInput,
  identity: CodexIdentity,
  preparation: ProbeContext
): Promise<AgentLaunchConfigInput> => {
  const codexExecutable = [identity.executable, identity.launcher].some(
    (path) => path !== null && /^codex(?:\.(?:exe|js|cmd|ps1))?$/i.test(basename(path))
  )
  if (identity.id !== 'codex' && !identity.version?.startsWith('codex-cli ') && !codexExecutable)
    return config
  await preparation.assertPolicy()
  preparation.execution.assertReserved()
  if (!identity.executable) {
    // Preserve the resolver's missing/inaccessible CLI diagnosis before probing.
    resolveCommandPath(config.command, preparation.cwd, preparation.env)
    throw new ExecutionPolicyError(
      'Codex process isolation cannot be checked without an executable.',
      ['codex_process_isolation_probe_failed']
    )
  }
  let supported = capabilities.get(identity.fingerprint)
  if (supported === undefined) {
    const result = await runNativeSessionProcess({
      ...preparation,
      command: identity.executable,
      args: ['--help'],
      env: { ...preparation.env, FORCE_COLOR: undefined, NO_COLOR: '1' },
      timeoutMs: 5000,
    })
    if (result.exitCode !== 0)
      throw new ExecutionPolicyError(
        `Codex --help failed with exit code ${result.exitCode}; process isolation was not verified.`,
        ['codex_process_isolation_probe_failed']
      )
    if (!/\bCodex\b/i.test(result.stdout) || !/^\s*Usage:/im.test(result.stdout))
      throw new ExecutionPolicyError(
        'Codex --help returned no recognizable help; process isolation was not verified.',
        ['codex_process_isolation_probe_failed']
      )
    supported = /^\s*(?:-[A-Za-z],\s*)?--no-daemon(?=\s|=|$)/m.test(result.stdout)
    capabilities.set(identity.fingerprint, supported)
  }
  if (!supported) return config
  const args = config.args ?? []
  const delimiter = args.indexOf('--')
  const optionEnd = delimiter < 0 ? args.length : delimiter
  if (args.slice(0, optionEnd).includes('--no-daemon')) return config
  return {
    ...config,
    args: [...args.slice(0, optionEnd), '--no-daemon', ...args.slice(optionEnd)],
  }
}
