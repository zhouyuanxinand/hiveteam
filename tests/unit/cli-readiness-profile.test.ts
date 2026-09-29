import { expect, test } from 'vitest'
import { getCliReadinessProfile } from '../../src/server/cli-readiness-profile.js'
import type { ExecutionCliIdentity } from '../../src/server/execution-cli-identity.js'

const identity = (id: string, version: string | null): ExecutionCliIdentity => ({
  id,
  version,
  executable: '/verified/codex',
  launcher: '/verified/codex',
  available: true,
  fingerprint: 'fixture-fingerprint',
})

test.each([
  'codex-cli 0.155.1',
  'codex-cli 0.158.0',
])('uses the fixed login status probe for recognized release %s', (version) => {
  expect(getCliReadinessProfile(identity('codex', version))).toEqual({
    args: ['login', 'status'],
    protocol: 'codex-login-status-v1',
  })
})

test.each([
  ['codex', null],
  ['codex', 'codex-cli 0.158.0-alpha.2.1'],
  ['codex', 'codex-cli 0.159.0'],
  ['custom', 'codex-cli 0.158.0'],
] as const)('does not probe unverified CLI %s %s', (id, version) => {
  expect(getCliReadinessProfile(identity(id, version))).toBeNull()
})
