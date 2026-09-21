import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { VerificationProfile } from '../shared/verification-profile.js'
import { BadRequestError, HttpError } from './http-errors.js'

const command = (value: unknown) =>
  typeof value === 'string' && !!value.trim() && value.length <= 2000 && !value.includes('\0')
export const validateVerificationProfile = (
  input: unknown,
  id: string = randomUUID()
): VerificationProfile => {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new BadRequestError('A verification profile object is required')
  const p = input as Record<string, unknown>
  const result = {
    id,
    name: p.name,
    command: p.command,
    prepare_commands: p.prepare_commands ?? [],
    timeout_ms: p.timeout_ms ?? 900000,
    required_env: p.required_env ?? [],
    execution: p.execution ?? 'restricted',
    network: p.network ?? 'none',
    max_parallel: p.max_parallel ?? 1,
  }
  if (
    typeof result.name !== 'string' ||
    !result.name.trim() ||
    result.name.length > 100 ||
    !command(result.command) ||
    !Array.isArray(result.prepare_commands) ||
    result.prepare_commands.length > 10 ||
    !result.prepare_commands.every(command) ||
    typeof result.timeout_ms !== 'number' ||
    !Number.isSafeInteger(result.timeout_ms) ||
    result.timeout_ms < 1000 ||
    result.timeout_ms > 86400000 ||
    !Array.isArray(result.required_env) ||
    result.required_env.length > 20 ||
    result.required_env.some(
      (key) =>
        typeof key !== 'string' ||
        !/^[A-Z][A-Z0-9_]{0,79}$/u.test(key) ||
        /^(?:HIVE_|CODEX_|NODE_OPTIONS$|LD_|DYLD_|PATH$|HOME$|GIT_)/u.test(key)
    ) ||
    !['restricted', 'trusted_unsafe'].includes(String(result.execution)) ||
    !['none', 'unrestricted'].includes(String(result.network)) ||
    typeof result.max_parallel !== 'number' ||
    !Number.isSafeInteger(result.max_parallel) ||
    result.max_parallel < 1 ||
    result.max_parallel > 16
  )
    throw new BadRequestError(
      'Invalid verification profile: provide commands, a 1s–24h timeout, environment variable names and concurrency 1–16.'
    )
  if (result.execution === 'restricted' && result.network !== 'none')
    throw new BadRequestError('The verified restricted execution profile requires network: none.')
  if (result.execution === 'trusted_unsafe' && result.network !== 'unrestricted')
    throw new BadRequestError(
      'Trusted host execution cannot enforce network isolation. Choose network: unrestricted explicitly.'
    )
  return result as VerificationProfile
}
export const legacyVerificationProfile = (command: string): VerificationProfile => ({
  id: 'legacy-command',
  name: 'Explicit host command',
  command,
  prepare_commands: [],
  timeout_ms: 900000,
  required_env: [],
  execution: 'trusted_unsafe',
  network: 'unrestricted',
  max_parallel: 1,
})
export const createVerificationProfiles = (db: Database) => ({
  list(workspaceId: string): VerificationProfile[] {
    return (
      db
        .prepare(
          'SELECT profile_json FROM verification_profiles WHERE workspace_id=? ORDER BY updated_at DESC,id'
        )
        .all(workspaceId) as Array<{ profile_json: string }>
    ).map((row) => JSON.parse(row.profile_json))
  },
  get(workspaceId: string, id: string): VerificationProfile {
    const row = db
      .prepare('SELECT profile_json FROM verification_profiles WHERE workspace_id=? AND id=?')
      .get(workspaceId, id) as { profile_json: string } | undefined
    if (!row) throw new HttpError(404, 'Verification profile not found')
    return JSON.parse(row.profile_json)
  },
  save(workspaceId: string, body: unknown, id?: string) {
    const profile = validateVerificationProfile(body, id)
    db.prepare(
      `INSERT INTO verification_profiles VALUES(?,?,?,?) ON CONFLICT(workspace_id,id) DO UPDATE SET profile_json=excluded.profile_json,updated_at=excluded.updated_at`
    ).run(workspaceId, profile.id, JSON.stringify(profile), Date.now())
    return profile
  },
})
