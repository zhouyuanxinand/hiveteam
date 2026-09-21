export type SessionHarness = 'cursor' | 'grok'
export type SessionCapabilityName =
  | 'allocate'
  | 'resume_by_id'
  | 'existence_check'
  | 'ownership'
  | 'delivery_receipt'

export interface SessionCliTranscript {
  exit_code: number | null
  stdout: string
  stderr: string
}

/** Imported observations describe an isolated CLI, not the runtime's installed executable. */
export interface SessionCliDiagnostic {
  command: string
  platform: 'win32' | 'linux' | 'darwin'
  version: SessionCliTranscript
  help: SessionCliTranscript
}

export interface SessionCapabilityEvidence {
  documentation: 'documented' | 'unverified'
  source_url: string
  detail: string
  help_observation: 'advertised' | 'not_observed' | 'not_provided' | 'command_failed'
  runtime_support: 'unverified'
}

export interface SessionAdapterReport {
  harness: SessionHarness
  display_name: string
  documentation_checked_at: string
  commands: string[]
  diagnostic_commands: { version: string[]; help: string[] }
  capabilities: Record<SessionCapabilityName, SessionCapabilityEvidence>
  verified_releases: string[]
  automatic_resume: { allowed: false; reason_code: 'session_adapter_unverified'; reason: string }
  diagnostic: {
    source: 'imported'
    command: string
    platform: SessionCliDiagnostic['platform']
    version_label: string | null
    version_status: 'reported' | 'command_failed' | 'unrecognized_output'
    help_status: 'reported' | 'command_failed'
  } | null
}

export interface InstalledSessionAdapterReport extends SessionAdapterReport {
  runtime_platform: string
  command_locations: {
    command: string
    status: 'resolved' | 'missing' | 'unusable'
    path: string | null
    error_code: string | null
  }[]
}
