import type { ExecutionPolicyView } from '../shared/execution-policy.js'
import type { SessionHarness } from '../shared/session-adapter.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import { normalizeExecutableToken } from './startup-command-parser.js'

export interface NativeSessionProfile {
  executable_sha256: string
  revision: string
  harness: SessionHarness
  platform: NodeJS.Platform
  version: string
  invocation_prefix?: readonly string[]
  // Identity hooks prove only identity; neither prompt readiness nor final delivery.
  startup_identity: 'private_plugin'
  cursor_existence: 'acp_load'
  grok_storage: 'summary_v1'
}

export const nativeSessionHarness = (config: AgentLaunchConfigInput): SessionHarness | null => {
  const token = normalizeExecutableToken(config.interactiveCommand ?? config.command)
  if (token === 'agent' || token === 'cursor-agent') return 'cursor'
  if (token === 'grok') return 'grok'
  return null
}

/** Release evidence must cover exact executable/platform, ACP/store semantics and hooks together.
 * Offline diagnostics and help flags are deliberately not an executable allowlist.
 * No vendor release has completed the isolated native acceptance run yet.
 */
export const NATIVE_SESSION_RELEASES: readonly NativeSessionProfile[] = []
export const verifiedNativeSessionProfile = (
  harness: SessionHarness,
  policy: ExecutionPolicyView
): NativeSessionProfile | null =>
  NATIVE_SESSION_RELEASES.find(
    (profile) =>
      profile.harness === harness &&
      profile.platform === policy.platform &&
      profile.executable_sha256 === policy.cli_artifact_sha256
  ) ?? null
