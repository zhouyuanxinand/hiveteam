import type { ExecutionCliIdentity } from './execution-cli-identity.js'

export interface CliReadinessProfile {
  args: string[]
  protocol: 'codex-login-status-v1'
}
// Version labels here come from execution-cli-identity's exact release SHA-256 matrix,
// never from user-supplied version/help text. Other CLIs remain explicitly unknown.
export const getCliReadinessProfile = (
  identity: ExecutionCliIdentity
): CliReadinessProfile | null =>
  identity.id === 'codex' &&
  (identity.version === 'codex-cli 0.155.1' || identity.version === 'codex-cli 0.158.0')
    ? { args: ['login', 'status'], protocol: 'codex-login-status-v1' }
    : null

export const decodeCliAuthentication = (exitCode: number | null, output: string) => {
  const line = output.trim()
  if (exitCode === 1 && line === 'Not logged in') return 'missing' as const
  if (
    exitCode === 0 &&
    /^Logged in using (?:ChatGPT|an API key - [^\r\n]+|access token|personal access token|Amazon Bedrock API key|Amazon Bedrock AWS access keys|workload identity)$/u.test(
      line
    )
  )
    return 'present' as const
  return 'unknown' as const
}
