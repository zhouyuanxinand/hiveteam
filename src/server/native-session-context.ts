import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { ExecutionPolicyView } from '../shared/execution-policy.js'
import type { NativeSessionContext } from '../shared/native-session.js'
import type { SessionHarness } from '../shared/session-adapter.js'

export const canonicalSessionPath = (path: string) => {
  const absolute = resolve(path)
  let canonical: string
  try {
    canonical = realpathSync.native(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(absolute)
    if (parent === absolute) throw error
    canonical = join(canonicalSessionPath(parent), basename(absolute))
  }
  return canonical
}

export const nativeSessionContext = (
  harness: SessionHarness,
  cwd: string,
  policy: ExecutionPolicyView,
  revision: string
): NativeSessionContext => ({
  cwd: canonicalSessionPath(cwd),
  platform: process.platform,
  storage_root: canonicalSessionPath(
    harness === 'grok'
      ? (process.env.GROK_HOME ?? join(homedir(), '.grok'))
      : join(homedir(), '.cursor')
  ),
  policy_revision: createHash('sha256')
    .update(
      JSON.stringify({
        revision: policy.policy_revision,
        role: policy.role,
        profile: policy.profile,
        actual: policy.actual,
      })
    )
    .digest('hex'),
  cli_fingerprint: policy.cli_fingerprint,
  adapter_revision: revision,
})
