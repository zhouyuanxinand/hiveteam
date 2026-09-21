export interface CliReadiness {
  state: 'missing' | 'unverified' | 'incompatible' | 'authentication_required' | 'ready' | 'failed'
  command_found: boolean
  version: string | null
  cli_fingerprint: string | null
  parameters: 'supported' | 'unsupported' | 'unknown'
  authentication: 'present' | 'missing' | 'unknown'
  authentication_scope: 'managed_cli_home' | 'current_cli_home' | 'unknown'
  execution: 'allowed' | 'blocked' | 'pending'
  session: 'unverified' | 'existing_adapter'
  reason_codes: string[]
  checked_at: number
  probe_available: boolean
  probe_exit_code: number | null
  model_request_performed: false
}
