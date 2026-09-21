import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { CliReadiness } from '../shared/cli-readiness.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import { decodeCliAuthentication, getCliReadinessProfile } from './cli-readiness-profile.js'
import { readExecutionCliIdentity } from './execution-cli-identity.js'
import { type ExecutionPolicyRuntime, permittedCodexArgs } from './execution-policy-runtime.js'
import { ConflictError, HttpError } from './http-errors.js'
import { createManagedExecution } from './managed-execution.js'
import { runNativeSessionProcess } from './native-session-process.js'
import { nativeSessionHarness, verifiedNativeSessionProfile } from './native-session-profile.js'
import type { ResourceBudgetStore } from './resource-budget-store.js'

export const createCliReadiness = (input: {
  policies: ExecutionPolicyRuntime
  resources: ResourceBudgetStore
  dataDir: string | null
  getConfig: (workspaceId: string, agentId: string) => AgentLaunchConfigInput | undefined
  getCwd: (workspaceId: string, agentId: string) => string
}) => {
  const inspect = async (workspaceId: string, agentId: string) => {
    const cwd = input.getCwd(workspaceId, agentId),
      config = input.getConfig(workspaceId, agentId)
    if (!config) throw new ConflictError('Configure a CLI before checking readiness.')
    const identity = await readExecutionCliIdentity(config, cwd)
    const policy = await input.policies.preview(workspaceId, agentId)
    const profile = getCliReadinessProfile(identity),
      harness = nativeSessionHarness(config)
    const view: CliReadiness = {
      state: 'unverified',
      command_found: identity.available,
      version: identity.version,
      cli_fingerprint: identity.fingerprint,
      parameters: profile
        ? permittedCodexArgs(config.args ?? [])
          ? 'supported'
          : 'unsupported'
        : 'unknown',
      authentication: 'unknown',
      authentication_scope: 'unknown',
      execution:
        policy.enforcement === 'trusted_unsafe' || policy.enforcement === 'enforced'
          ? 'allowed'
          : policy.enforcement === 'unsupported'
            ? 'blocked'
            : 'pending',
      session:
        harness && !verifiedNativeSessionProfile(harness, policy)
          ? 'unverified'
          : 'existing_adapter',
      reason_codes: [],
      checked_at: Date.now(),
      probe_available: !!profile && identity.available,
      probe_exit_code: null,
      model_request_performed: false,
    }
    if (!identity.available) {
      view.state = identity.unavailableReason === 'EACCES' ? 'failed' : 'missing'
      view.reason_codes.push(view.state === 'failed' ? 'command_access_denied' : 'command_missing')
    } else if (view.parameters === 'unsupported') {
      view.state = 'incompatible'
      view.reason_codes.push('parameters_outside_verified_profile')
    } else if (view.execution === 'blocked') {
      view.state = 'incompatible'
      view.reason_codes.push('execution_policy_blocked', ...policy.missing_capabilities)
    }
    if (!profile) view.reason_codes.push('version_or_authentication_probe_unverified')
    if (view.session === 'unverified') view.reason_codes.push('native_session_adapter_unverified')
    if (view.execution === 'pending') view.reason_codes.push('execution_preflight_pending')
    view.reason_codes.push('authentication_not_checked')
    return { view, profile, identity, policy, config }
  }
  return {
    async view(workspaceId: string, agentId: string) {
      return (await inspect(workspaceId, agentId)).view
    },
    async probe(workspaceId: string, agentId: string, fingerprint: string): Promise<CliReadiness> {
      const { view, profile, identity, policy } = await inspect(workspaceId, agentId)
      if (identity.fingerprint !== fingerprint)
        throw new ConflictError('CLI changed. Refresh readiness before checking authentication.')
      if (!profile || !identity.executable || !identity.available) return view
      if (view.parameters === 'unsupported') return view
      const managedHome = policy.profile === 'restricted'
      if (managedHome && !input.dataDir) return view
      const authHome = managedHome
        ? join(
            input.dataDir ?? '',
            'execution-policies',
            agentId.replaceAll(':', '_'),
            'codex-home'
          )
        : resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex'))
      if (managedHome) await mkdir(authHome, { recursive: true, mode: 0o700 })
      const reservation = input.resources.reserve({
        workspaceId,
        executionKey: `readiness:${randomUUID()}`,
        kind: 'verification',
      })
      const execution = createManagedExecution(input.resources, reservation)
      let scratch: string | undefined
      try {
        scratch = await mkdtemp(join(tmpdir(), 'hive-cli-readiness-'))
        const result = await runNativeSessionProcess({
          command: identity.executable,
          args: profile.args,
          cwd: scratch,
          env: { HOME: scratch, USERPROFILE: scratch, CODEX_HOME: authHome },
          execution,
          timeoutMs: 10000,
          assertPolicy: async () => {
            const latest = await inspect(workspaceId, agentId)
            if (
              latest.identity.fingerprint !== fingerprint ||
              latest.policy.profile !== policy.profile
            )
              throw new ConflictError('CLI or execution policy changed during readiness check.')
          },
        })
        view.authentication = decodeCliAuthentication(
          result.exitCode,
          `${result.stdout}${result.stderr}`
        )
        view.authentication_scope = managedHome ? 'managed_cli_home' : 'current_cli_home'
        view.probe_exit_code = result.exitCode
        view.reason_codes = view.reason_codes.filter(
          (code) => code !== 'authentication_not_checked'
        )
        if (view.authentication === 'unknown') {
          view.state = 'failed'
          view.reason_codes.push('authentication_probe_failed')
        } else if (view.authentication === 'missing') {
          view.state = 'authentication_required'
          view.reason_codes.push('cli_login_required')
        } else if (view.execution === 'allowed' && view.session !== 'unverified')
          view.state = 'ready'
        return { ...view, checked_at: Date.now() }
      } catch (cause) {
        if (cause instanceof ConflictError) throw cause
        const error = new HttpError(
          409,
          'CLI readiness check failed. No raw CLI output was retained; check the command and retry.'
        )
        throw Object.assign(error, { code: 'cli_readiness_probe_failed', cause })
      } finally {
        execution.releaseAfterCleanup()
        if (scratch) await rm(scratch, { recursive: true, force: true })
      }
    },
  }
}
export type CliReadinessRuntime = ReturnType<typeof createCliReadiness>
