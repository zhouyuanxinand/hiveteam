import type { AgentSummary } from './types.js'

export const EXECUTION_POLICY_REVISION = 1

export type ExecutionProfile = 'restricted' | 'trusted_unsafe'
export type ExecutionEnforcement = 'enforced' | 'pending' | 'unsupported' | 'trusted_unsafe'

/** Public payloads deliberately retain snake_case at the HTTP boundary. */
export interface ExecutionPermissions {
  read_roots: string[]
  write_roots: string[]
  deny_roots?: string[]
  network: 'none' | 'unrestricted'
  credentials: 'isolated_cli_home' | 'trusted_cli'
  approval: 'never' | 'cli_default'
  git_operations: Array<'read' | 'controlled_commit' | 'unrestricted'>
}

export interface UnsafeExecutionGrant {
  granted_at: number
  cli_fingerprint: string
  cli_version: string | null
  policy_revision: number
}

export interface ExecutionPolicyView {
  cli_artifact_sha256?: string
  workspace_id: string
  agent_id: string
  role: AgentSummary['role']
  profile: ExecutionProfile
  policy_revision: number
  platform: string
  cli_id: string
  cli_version: string | null
  cli_fingerprint: string
  enforcement: ExecutionEnforcement
  requested: ExecutionPermissions
  actual: ExecutionPermissions | null
  missing_capabilities: string[]
  warnings: string[]
  unsafe_grant: UnsafeExecutionGrant | null
  checkout_head_sha?: string
  active_policy?: {
    policy_id: string
    created_at: number
    profile: ExecutionProfile
    enforcement: ExecutionEnforcement
    actual: ExecutionPermissions | null
    cli_version: string | null
    policy_revision: number
    checkout_head_sha?: string
  } | null
  active_run_unverified?: boolean
}

export interface ExecutionPolicyUpdate {
  profile: ExecutionProfile
  expected_cli_fingerprint: string
  expected_cli_version: string | null
  policy_revision: number
  acknowledge_unsafe?: boolean
}

export interface ExecutionPolicySnapshot extends ExecutionPolicyView {
  policy_id: string
  created_at: number
  launch: { command: string; args: string[]; cwd: string; environment_keys: string[] }
}
