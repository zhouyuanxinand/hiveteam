import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { describeSessionAdapter } from '../../src/server/session-adapter-capabilities.js'
import {
  inspectInstalledSessionAdapter,
  readSessionDiagnostic,
} from '../../src/server/session-adapter-diagnostics.js'
import { cursorDiagnostic, grokDiagnostic } from '../fixtures/session-cli-diagnostics.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('offline session adapter capability evidence', () => {
  test.each([
    'cursor',
    'grok',
  ] as const)('separates %s documentation, help observations and verified behavior', (harness) => {
    const diagnostic = harness === 'cursor' ? cursorDiagnostic : grokDiagnostic
    const report = describeSessionAdapter(harness, readSessionDiagnostic(harness, diagnostic))
    expect(report.diagnostic).toMatchObject({
      source: 'imported',
      command: diagnostic.command,
      platform: diagnostic.platform,
      version_label: diagnostic.version.stdout.trim(),
      version_status: 'reported',
    })
    for (const name of ['allocate', 'resume_by_id'] as const) {
      expect(report.capabilities[name]).toMatchObject({
        documentation: 'documented',
        help_observation: 'advertised',
        runtime_support: 'unverified',
      })
    }
    for (const name of ['existence_check', 'ownership', 'delivery_receipt'] as const) {
      expect(report.capabilities[name]).toMatchObject({
        documentation: 'unverified',
        help_observation: 'not_observed',
        runtime_support: 'unverified',
      })
    }
    expect(report.verified_releases).toEqual([])
    expect(report.automatic_resume).toMatchObject({
      allowed: false,
      reason_code: 'session_adapter_unverified',
    })
    expect(report.diagnostic_commands).toEqual({
      version: harness === 'cursor' ? ['--version'] : ['version'],
      help: ['--help'],
    })
  })

  test('does not infer explicit-ID recovery from latest-session flags, examples or similar option names', () => {
    const report = describeSessionAdapter('cursor', {
      ...cursorDiagnostic,
      help: {
        exit_code: 0,
        stderr: '',
        stdout:
          'Use --resume [ID] in another CLI.\n  --continue\n  --resume-latest [ID]\n  --resume\n  [ID]\n  --resume [ID>\n  create-chat-disabled\n',
      },
    })
    expect(report.capabilities.allocate.help_observation).toBe('not_observed')
    expect(report.capabilities.resume_by_id.help_observation).toBe('not_observed')
    expect(report.capabilities.resume_by_id.documentation).toBe('documented')
    expect(report.automatic_resume.allowed).toBe(false)
  })

  test('failed or interrupted diagnostics never provide successful evidence', () => {
    for (const exit_code of [1, null]) {
      const report = describeSessionAdapter('grok', {
        ...grokDiagnostic,
        version: { ...grokDiagnostic.version, exit_code },
        help: { ...grokDiagnostic.help, exit_code },
      })
      expect(report.diagnostic).toMatchObject({
        version_label: null,
        version_status: 'command_failed',
        help_status: 'command_failed',
      })
      expect(report.capabilities.allocate.help_observation).toBe('command_failed')
      expect(report.capabilities.resume_by_id.help_observation).toBe('command_failed')
    }
  })

  test('keeps version labels opaque and bounded; handles terminal styling and stderr output', () => {
    const styled = describeSessionAdapter('cursor', {
      ...cursorDiagnostic,
      version: { exit_code: 0, stdout: '', stderr: '\u001b[32m2099.01.01-fixture\u001b[0m\n' },
    })
    expect(styled.diagnostic?.version_label).toBe('2099.01.01-fixture')
    expect(styled.verified_releases).toEqual([])
    for (const stdout of [
      '',
      'login required\nnot a version',
      'x'.repeat(161),
      'version\u202Eevil',
      'version\u2028second line',
      'version\u2029second paragraph',
    ]) {
      expect(
        describeSessionAdapter('cursor', {
          ...cursorDiagnostic,
          version: { exit_code: 0, stdout, stderr: '' },
        }).diagnostic
      ).toMatchObject({ version_label: null, version_status: 'unrecognized_output' })
    }
  })

  test('validates transcripts and command identities without accepting command strings', () => {
    expect(
      readSessionDiagnostic('cursor', { ...cursorDiagnostic, command: 'cursor-agent' }).command
    ).toBe('cursor-agent')
    for (const body of [
      null,
      [],
      {},
      { ...grokDiagnostic, command: 'grok-cli' },
      { ...grokDiagnostic, command: 'grok && echo secret' },
      { ...grokDiagnostic, platform: 'unknown' },
      { ...grokDiagnostic, version: { exit_code: '0', stdout: 'v1', stderr: '' } },
      { ...grokDiagnostic, version: { exit_code: 0, stdout: 'x'.repeat(4097), stderr: '' } },
    ]) {
      expect(() => readSessionDiagnostic('grok', body)).toThrow(
        expect.objectContaining({ code: 'invalid_session_diagnostic', statusCode: 400 })
      )
    }
  })

  test('command resolution is not vendor or version verification, and missing commands remain explicit', () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-session-availability-'))
    roots.push(root)
    const command = join(root, process.platform === 'win32' ? 'agent.cmd' : 'agent')
    writeFileSync(command, 'This is deliberately not a working vendor CLI.\n')
    if (process.platform !== 'win32') chmodSync(command, 0o700)
    const windowsApps = join(root, 'WindowsApps')
    mkdirSync(windowsApps)
    const report = inspectInstalledSessionAdapter('cursor', root, {
      PATH: `${windowsApps}${delimiter}${root}`,
    })
    expect(report.command_locations).toEqual([
      { command: 'agent', status: 'resolved', path: expect.any(String), error_code: null },
      { command: 'cursor-agent', status: 'missing', path: null, error_code: 'ENOENT' },
    ])
    const expectedFile = statSync(command)
    expect(statSync(report.command_locations[0]?.path ?? '')).toMatchObject({
      dev: expectedFile.dev,
      ino: expectedFile.ino,
    })
    expect(report.diagnostic).toBeNull()
    expect(report.verified_releases).toEqual([])
    expect(report.automatic_resume.allowed).toBe(false)
    expect(report.capabilities.resume_by_id.help_observation).toBe('not_provided')
  })
})
