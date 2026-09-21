export interface VerificationProfile {
  id: string
  name: string
  command: string
  prepare_commands: string[]
  timeout_ms: number
  required_env: string[]
  execution: 'restricted' | 'trusted_unsafe'
  network: 'none' | 'unrestricted'
  max_parallel: number
}
export interface VerificationLogPage {
  text: string
  offset: number
  next_offset: number
  total_bytes: number
  truncated: boolean
  redacted: boolean
}
