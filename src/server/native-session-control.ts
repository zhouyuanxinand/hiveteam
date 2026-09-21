import type { NativeSessionView } from '../shared/native-session.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { ExecutionPolicyRuntime } from './execution-policy-runtime.js'
import { BadRequestError } from './http-errors.js'
import { nativeSessionContext } from './native-session-context.js'
import { NativeSessionError } from './native-session-error.js'
import { nativeSessionHarness, verifiedNativeSessionProfile } from './native-session-profile.js'
import type { NativeSessionStore } from './native-session-store.js'
import type { ResourceBudgetStore } from './resource-budget-store.js'

export const createNativeSessionControl = (input: {
  sessions: NativeSessionStore
  policies: ExecutionPolicyRuntime
  resources: ResourceBudgetStore
  getConfig: (workspaceId: string, agentId: string) => AgentLaunchConfigInput | undefined
  getCwd: (workspaceId: string, agentId: string) => string
}) => {
  const inspect = async (workspaceId: string, agentId: string) => {
    const cwd = input.getCwd(workspaceId, agentId)
    const config = input.getConfig(workspaceId, agentId)
    input.sessions.reconcile()
    let current = input.sessions.current(workspaceId, agentId)
    const harness = config ? nativeSessionHarness(config) : null
    const policy = harness ? await input.policies.preview(workspaceId, agentId) : null
    const profile = harness && policy ? verifiedNativeSessionProfile(harness, policy) : null
    const context =
      harness && policy
        ? nativeSessionContext(harness, cwd, policy, profile?.revision ?? 'unverified')
        : null
    if (harness && context)
      current = input.sessions.adoptLegacy(workspaceId, agentId, harness, context)
    return { harness, current, profile, context, policy }
  }
  return {
    async view(workspaceId: string, agentId: string): Promise<NativeSessionView> {
      const { harness, current, profile, context, policy } = await inspect(workspaceId, agentId)
      const active = input.resources.findActive(workspaceId, `agent:${agentId}`)
      const mismatch =
        current &&
        (current.harness !== harness || JSON.stringify(current.context) !== JSON.stringify(context))
      const code =
        current?.state === 'uncertain'
          ? 'session_allocation_uncertain'
          : active
            ? 'session_occupied'
            : !profile && harness
              ? 'session_adapter_unverified'
              : mismatch
                ? 'session_environment_mismatch'
                : (current?.last_error?.code ?? null)
      const messages = {
        session_allocation_uncertain:
          'Allocation may have completed without a saved ID. Inspect it before explicitly choosing a new session.',
        session_occupied:
          'This member has an active or unconfirmed execution. Stop it before changing its session.',
        session_adapter_unverified:
          'This executable/platform has no verified native session profile. Automatic allocation and recovery are blocked.',
        session_environment_mismatch:
          'The session environment changed. Review the current cwd, storage and execution policy before rebinding.',
      }
      return {
        harness: harness ?? current?.harness ?? null,
        current,
        history: input.sessions.history(workspaceId, agentId),
        attempts: current ? input.sessions.attempts(current.id) : [],
        recoverable: Boolean(current?.native_id && !code && profile),
        reason_code: code,
        reason: code
          ? code in messages
            ? messages[code as keyof typeof messages]
            : (current?.last_error?.message ?? code)
          : current?.native_id
            ? 'The next start will check and resume this explicit ID.'
            : 'The next verified start will allocate and bind a new native ID.',
        proposed_context: context,
        proposed_policy: policy
          ? {
              profile: policy.profile,
              role: policy.role,
              network: policy.actual?.network ?? null,
              write_roots: policy.actual?.write_roots ?? [],
            }
          : null,
        external_ownership: 'unknown',
        delivery_receipt: 'unverified',
        automatic_input: false,
      }
    },
    async change(workspaceId: string, agentId: string, body: unknown) {
      if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new BadRequestError('Session change must be an object.')
      const value = body as Record<string, unknown>
      if (
        !['new', 'rebind'].includes(String(value.action)) ||
        typeof value.expected_generation_id !== 'string' ||
        typeof value.reason !== 'string' ||
        !value.reason.trim() ||
        value.reason.length > 2000 ||
        value.acknowledge !== true
      )
        throw new BadRequestError(
          'Choose new or rebind, provide the expected generation and a reason, and acknowledge the change.'
        )
      const { harness, context } = await inspect(workspaceId, agentId)
      if (!harness || !context)
        throw new NativeSessionError(
          'session_environment_mismatch',
          'Configure a Cursor or Grok command before changing its native session.'
        )
      if (input.resources.findActive(workspaceId, `agent:${agentId}`))
        throw new NativeSessionError(
          'session_occupied',
          'Stop this member and resolve any resource recovery before changing its session.'
        )
      if (JSON.stringify(value.expected_context) !== JSON.stringify(context))
        throw new NativeSessionError(
          'session_environment_mismatch',
          'The proposed environment changed. Refresh and review it again.'
        )
      if (value.action === 'new')
        input.sessions.newGeneration(
          workspaceId,
          agentId,
          value.expected_generation_id,
          value.reason.trim(),
          harness,
          context
        )
      else {
        const current = input.sessions.current(workspaceId, agentId)
        if (current?.harness !== harness)
          throw new NativeSessionError(
            'session_environment_mismatch',
            'An existing session cannot change harness. Choose a new generation explicitly.'
          )
        input.sessions.rebind(
          workspaceId,
          agentId,
          value.expected_generation_id,
          context,
          value.reason.trim()
        )
      }
      return this.view(workspaceId, agentId)
    },
  }
}
export type NativeSessionControl = ReturnType<typeof createNativeSessionControl>
