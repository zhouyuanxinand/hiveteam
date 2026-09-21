import { stripVTControlCharacters } from 'node:util'
import type {
  SessionAdapterReport,
  SessionCapabilityEvidence,
  SessionCapabilityName,
  SessionCliDiagnostic,
  SessionHarness,
} from '../shared/session-adapter.js'

const CURSOR_PARAMETERS = 'https://cursor.com/docs/cli/reference/parameters'
const GROK_SESSIONS = 'https://docs.x.ai/build/features/sessions'
const GROK_REFERENCE = 'https://docs.x.ai/build/cli/reference'

type CapabilityDefinition = Pick<
  SessionCapabilityEvidence,
  'documentation' | 'source_url' | 'detail'
>
interface AdapterDefinition {
  displayName: string
  commands: string[]
  versionArgs: string[]
  capabilities: Record<SessionCapabilityName, CapabilityDefinition>
  advertised: (name: SessionCapabilityName, help: string) => boolean
}

const evidence = (
  documentation: CapabilityDefinition['documentation'],
  source_url: string,
  detail: string
): CapabilityDefinition => ({ documentation, source_url, detail })

// Only option declarations with an explicit value count as help observations.
// These expressions detect advertised syntax, never native session behavior.
const advertisesResumeId = (help: string) =>
  /^[ \t]*(?:-r,?[ \t]+)?--resume(?:[ \t]+|=)(?:\[[\w-]+\]|<[\w-]+>)(?:\s|$)/mu.test(help)

const adapters: Record<SessionHarness, AdapterDefinition> = {
  cursor: {
    displayName: 'Cursor Agent',
    commands: ['agent', 'cursor-agent'],
    versionArgs: ['--version'],
    capabilities: {
      allocate: evidence(
        'documented',
        CURSOR_PARAMETERS,
        'create-chat returns an empty chat ID. Allocation side effects and output format have not been verified.'
      ),
      resume_by_id: evidence(
        'documented',
        CURSOR_PARAMETERS,
        '--resume <chatId> selects an existing chat. Do not use --continue or an omitted ID.'
      ),
      existence_check: evidence(
        'unverified',
        CURSOR_PARAMETERS,
        'Listing chats does not establish an exact-ID existence check with distinct missing and access-denied results.'
      ),
      ownership: evidence(
        'unverified',
        CURSOR_PARAMETERS,
        'No verified native exclusive-writer mechanism for an externally occupied chat.'
      ),
      delivery_receipt: evidence(
        'unverified',
        'https://cursor.com/docs/cli/reference/output-format',
        'Headless structured output does not establish an acceptance receipt for Hive interactive PTY input.'
      ),
    },
    advertised: (name, help) =>
      (name === 'allocate' && /^[ \t]*create-chat(?:\s|$)/mu.test(help)) ||
      (name === 'resume_by_id' && advertisesResumeId(help)),
  },
  grok: {
    displayName: 'Grok CLI',
    commands: ['grok'],
    versionArgs: ['version'],
    capabilities: {
      allocate: evidence(
        'documented',
        GROK_SESSIONS,
        '--session-id <UUID> names a new session. UUID generation is local; native persistence is not yet verified.'
      ),
      resume_by_id: evidence(
        'documented',
        GROK_SESSIONS,
        '--resume <ID> restores an existing session. --session-id and most-recent shortcuts must not be used for recovery.'
      ),
      existence_check: evidence(
        'unverified',
        GROK_SESSIONS,
        'sessions list and export are documented, but exact-ID absence, access errors and storage schema remain unverified.'
      ),
      ownership: evidence(
        'unverified',
        GROK_REFERENCE,
        'No verified native exclusive-writer mechanism for external processes; a Hive lock cannot prove global ownership.'
      ),
      delivery_receipt: evidence(
        'unverified',
        GROK_REFERENCE,
        'Headless JSON/streaming-json and ACP do not establish an acceptance receipt for Hive interactive PTY input.'
      ),
    },
    advertised: (name, help) =>
      (name === 'allocate' &&
        /^[ \t]*(?:-s,?[ \t]+)?--session-id(?:[ \t]+|=)(?:\[[\w-]+\]|<[\w-]+>)(?:\s|$)/mu.test(
          help
        )) ||
      (name === 'resume_by_id' && advertisesResumeId(help)),
  },
}

export const SESSION_HARNESSES: readonly SessionHarness[] = ['cursor', 'grok']
export const isSessionHarness = (value: string): value is SessionHarness =>
  value === 'cursor' || value === 'grok'

const versionLabel = (diagnostic: SessionCliDiagnostic): string | null => {
  if (diagnostic.version.exit_code !== 0) return null
  const label = stripVTControlCharacters(
    diagnostic.version.stdout.trim() || diagnostic.version.stderr.trim()
  ).trim()
  // Vendors do not specify a stable version-output schema. Preserve a bounded,
  // single-line label as untrusted evidence instead of inventing a version range.
  return label.length > 0 && label.length <= 160 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(label)
    ? label
    : null
}

export const describeSessionAdapter = (
  harness: SessionHarness,
  diagnostic?: SessionCliDiagnostic
): SessionAdapterReport => {
  const adapter = adapters[harness]
  const help =
    diagnostic?.help.exit_code === 0
      ? stripVTControlCharacters(diagnostic.help.stdout || diagnostic.help.stderr)
      : ''
  const capabilities = Object.fromEntries(
    Object.entries(adapter.capabilities).map(([name, definition]) => [
      name,
      {
        ...definition,
        help_observation: !diagnostic
          ? 'not_provided'
          : diagnostic.help.exit_code !== 0
            ? 'command_failed'
            : adapter.advertised(name as SessionCapabilityName, help)
              ? 'advertised'
              : 'not_observed',
        runtime_support: 'unverified',
      },
    ])
  ) as SessionAdapterReport['capabilities']
  const label = diagnostic ? versionLabel(diagnostic) : null
  return {
    harness,
    display_name: adapter.displayName,
    documentation_checked_at: '2026-09-20',
    commands: [...adapter.commands],
    diagnostic_commands: { version: [...adapter.versionArgs], help: ['--help'] },
    capabilities,
    verified_releases: [],
    automatic_resume: {
      allowed: false,
      reason_code: 'session_adapter_unverified',
      reason:
        'No Cursor/Grok release and platform has passed native identity, existence and recovery verification. Documentation and imported help cannot enable automatic recovery.',
    },
    diagnostic: diagnostic
      ? {
          source: 'imported',
          command: diagnostic.command,
          platform: diagnostic.platform,
          version_label: label,
          version_status:
            diagnostic.version.exit_code !== 0
              ? 'command_failed'
              : label
                ? 'reported'
                : 'unrecognized_output',
          help_status: diagnostic.help.exit_code === 0 ? 'reported' : 'command_failed',
        }
      : null,
  }
}
