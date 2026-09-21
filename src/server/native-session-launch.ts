import type { ExecutionPolicyView } from '../shared/execution-policy.js'
import type { AgentManager } from './agent-manager.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { ManagedExecution } from './managed-execution.js'
import {
  allocateNativeSession,
  checkCursorSession,
  checkGrokSession,
  nativeSessionArgs,
} from './native-session-adapters.js'
import { nativeSessionContext } from './native-session-context.js'
import { NativeSessionError } from './native-session-error.js'
import { createNativeSessionObserver } from './native-session-observer.js'
import { nativeSessionHarness, verifiedNativeSessionProfile } from './native-session-profile.js'
import type { NativeSessionStore } from './native-session-store.js'

export const prepareNativeSessionLaunch = async (input: {
  config: AgentLaunchConfigInput
  cwd: string
  workspaceId: string
  agentId: string
  env: NodeJS.ProcessEnv
  policy: ExecutionPolicyView
  execution: ManagedExecution
  sessions: NativeSessionStore | undefined
  assertPolicy: () => Promise<void>
}) => {
  const harness = nativeSessionHarness(input.config)
  if (!harness) return null
  const profile = verifiedNativeSessionProfile(harness, input.policy)
  const sessions = input.sessions
  if (!sessions)
    throw new NativeSessionError(
      'session_adapter_unverified',
      'The durable native session store is unavailable.'
    )
  const context = nativeSessionContext(
    harness,
    input.cwd,
    input.policy,
    profile?.revision ?? 'unverified'
  )
  sessions.adoptLegacy(input.workspaceId, input.agentId, harness, context)
  if (!profile)
    throw new NativeSessionError(
      'session_adapter_unverified',
      `This ${harness} executable/platform has no verified session release profile. Native allocation and automatic resume are blocked; existing history is retained.`
    )
  if (JSON.stringify(input.config.args ?? []) !== JSON.stringify(profile.invocation_prefix ?? []))
    throw new NativeSessionError(
      'session_environment_mismatch',
      'Custom native CLI arguments are not covered by this release profile. Remove prompt, session-selection and other extra arguments before managed allocation; no arguments are silently discarded.'
    )
  nativeSessionArgs(
    harness,
    harness === 'grok' ? '00000000-0000-4000-8000-000000000000' : 'validation',
    true,
    input.config.args ?? [],
    ''
  )
  const record = sessions.begin({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    harness,
    context,
    reservationId: input.execution.reservationId,
  })
  const env = harness === 'grok' ? { ...input.env, GROK_HOME: context.storage_root } : input.env
  const processInput = {
    command: input.config.command,
    args: input.config.args ?? [],
    cwd: input.cwd,
    env,
    execution: input.execution,
    assertPolicy: input.assertPolicy,
  }
  let observer: Awaited<ReturnType<typeof createNativeSessionObserver>> | undefined
  const fail = (error: unknown) =>
    sessions.fail(
      record.attempt.id,
      error instanceof NativeSessionError
        ? error
        : new NativeSessionError(
            'session_native_failure',
            error instanceof Error ? error.message : String(error),
            { cause: error }
          )
    )
  try {
    let binding = record.generation
    if (!binding.native_id) {
      sessions.allocating(record.attempt.id)
      const id = await allocateNativeSession(harness, processInput)
      binding = sessions.bind(record.attempt.id, id)
    }
    const id = binding.native_id
    if (!id)
      throw new NativeSessionError(
        'session_identity_mismatch',
        'Native allocation did not produce a durable ID.'
      )
    if (harness === 'cursor') await checkCursorSession(processInput, id)
    else if (record.attempt.operation === 'resume') await checkGrokSession(context, id)
    observer = await createNativeSessionObserver(harness, id, context.cwd)
    const args = nativeSessionArgs(
      harness,
      id,
      record.attempt.operation === 'allocate',
      input.config.args ?? [],
      observer.path
    )
    sessions.starting(record.attempt.id)
    const identityObserver = observer
    return {
      args,
      env,
      nativeId: id,
      fail,
      async verify(manager: AgentManager, runId: string) {
        await identityObserver.wait(
          () => ['starting', 'running'].includes(manager.getRun(runId).status),
          input.execution.signal
        )
        sessions.activate(record.attempt.id, runId)
      },
      async close() {
        sessions.close(record.attempt.id)
        await identityObserver.close()
      },
    }
  } catch (error) {
    try {
      fail(error)
    } finally {
      await observer?.close()
    }
    throw error
  }
}
