import type { AgentSummary, WorkspaceSummary } from '../shared/types.js'
import { discoverWorkspaceDocuments } from '../shared/workspace-documents.js'
import type { AgentManager } from './agent-manager.js'
import { buildAgentRunBootstrap, startAgentRunCapture } from './agent-run-bootstrap.js'
import { handleAgentRunExit } from './agent-run-exit-handler.js'
import type { AgentRunExitContext, AgentRunStarterStorePort } from './agent-run-start-context.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { AgentSessionStorePort } from './agent-runtime-ports.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import { buildAgentStartupInstructions } from './agent-startup-instructions.js'
import type { AgentTokenRegistry } from './agent-tokens.js'
import type { CommandPresetRecord } from './command-preset-store.js'
import { ExecutionPolicyError } from './execution-policy-error.js'
import type { ExecutionPolicyRuntime } from './execution-policy-runtime.js'
import type { LiveRunRegistry } from './live-run-registry.js'
import type { ManagedExecution } from './managed-execution.js'
import { prepareNativeSessionLaunch } from './native-session-launch.js'
import { createPostStartInputWriter, isInteractiveAgentCommand } from './post-start-input-writer.js'
import { recheckRemoteAction, withoutRemoteActionContext } from './remote-action-context.js'
import type { RestartPolicy } from './restart-policy.js'
import type { TeamSkillRuntime } from './team-skill-runtime.js'

interface AgentRunStarterInput {
  agentManager: AgentManager | undefined
  registry: LiveRunRegistry
  onAgentExit: (workspaceId: string, agentId: string) => void
  store: AgentRunStarterStorePort
  sessionStore: AgentSessionStorePort
  tokenRegistry: AgentTokenRegistry
  getCommandPreset: (id: string) => CommandPresetRecord | undefined
  getAgent: ((workspaceId: string, agentId: string) => AgentSummary | undefined) | undefined
  getStartupMemoryDigest?: (workspaceId: string, agent: AgentSummary, runId?: string) => string
  assertSkillLaunchReady: TeamSkillRuntime['assertLaunchReady']
  restartPolicy: RestartPolicy
  executionPolicies: Pick<ExecutionPolicyRuntime, 'prepare'> | undefined
}

const resolveCommandPresetId = (
  config: AgentLaunchConfigInput,
  getCommandPreset: (id: string) => CommandPresetRecord | undefined
) => {
  if (config.presetAugmentationDisabled) return null
  if (config.commandPresetId) return config.commandPresetId
  const implicit = getCommandPreset(config.command)
  return implicit?.command === config.command ? implicit.id : null
}

export const createAgentRunStarter =
  ({
    agentManager,
    registry,
    onAgentExit,
    store,
    sessionStore,
    tokenRegistry,
    getCommandPreset,
    getAgent,
    getStartupMemoryDigest,
    assertSkillLaunchReady,
    restartPolicy,
    executionPolicies,
  }: AgentRunStarterInput) =>
  async (
    workspace: WorkspaceSummary,
    agentId: string,
    config: AgentLaunchConfigInput,
    input: { autoResume?: boolean; hivePort: string; execution: ManagedExecution }
  ) => {
    if (!agentManager) throw new Error('Agent manager is required to start agents')
    input.execution.assertReserved()

    if (input.autoResume !== true) store.resetFastExitCount?.(agentId)

    const agent = getAgent?.(workspace.id, agentId)
    if (!executionPolicies)
      throw new ExecutionPolicyError(
        'Execution policy service is required before launching a member.',
        ['policy_service_unavailable']
      )
    const token = tokenRegistry.issue(agentId)
    let prepared: Awaited<ReturnType<ExecutionPolicyRuntime['prepare']>>
    try {
      prepared = await executionPolicies.prepare({
        workspace,
        agentId,
        config,
        token,
        execution: input.execution,
        hivePort: input.hivePort,
        isActive: () => tokenRegistry.validate(agentId, token),
        bootstrap: (compiledConfig, executionCwd) =>
          buildAgentRunBootstrap(
            { ...workspace, path: executionCwd ?? workspace.path },
            agentId,
            compiledConfig,
            sessionStore,
            getCommandPreset,
            agent
          ),
      })
    } catch (error) {
      tokenRegistry.revokeIfMatches(agentId, token)
      throw error
    }
    const { commitSessionContext, sessionCaptureSnapshot, startConfig, startEnv } = prepared
    let nativeLaunch: Awaited<ReturnType<typeof prepareNativeSessionLaunch>> = null
    let skillReadiness: Awaited<ReturnType<TeamSkillRuntime['assertLaunchReady']>>
    try {
      skillReadiness = await assertSkillLaunchReady({
        agentId,
        commandPresetId: resolveCommandPresetId(startConfig, getCommandPreset),
        workspaceId: workspace.id,
      })
      nativeLaunch = await prepareNativeSessionLaunch({
        config: startConfig,
        cwd: prepared.cwd,
        workspaceId: workspace.id,
        agentId,
        env: startEnv,
        policy: prepared.sessionPolicy,
        execution: input.execution,
        sessions: sessionStore.native,
        assertPolicy: prepared.assertCurrentPolicy,
      })
    } catch (error) {
      tokenRegistry.revokeIfMatches(agentId, token)
      await prepared.close()
      throw error
    }
    const handledRunExits = new Set<string>()
    const abortedRunIds = new Set<string>()
    const startedAt = Date.now()
    const exitContext: AgentRunExitContext = {
      agentId,
      handledRunExits,
      onAgentExit,
      registry,
      store,
      token,
      tokenRegistry,
      workspace,
    }
    const startInput = {
      execution: input.execution,
      afterNativeExit: async () => {
        await nativeLaunch?.close()
        await prepared.close()
      },
      agentId,
      command: startConfig.command,
      cwd: prepared.cwd,
      env: {
        ...startEnv,
        ...nativeLaunch?.env,
        COLORTERM: 'truecolor',
        FORCE_COLOR: '1',
        NO_COLOR: undefined,
        TERM: 'xterm-256color',
        TERM_PROGRAM: 'hive',
        HIVE_PORT: input.hivePort,
        HIVE_AGENT_TOKEN: token,
      },
      onExit: ({ runId, exitCode }: { runId: string; exitCode: number | null }) => {
        const endedAt = Date.now()
        if (
          !withoutRemoteActionContext(() =>
            handleAgentRunExit(exitContext, { exitCode, endedAt, runId })
          ) &&
          abortedRunIds.has(runId)
        ) {
          registry.clearPendingExitCode(runId)
          return
        }
      },
    }

    let run: Awaited<ReturnType<AgentManager['startAgent']>>
    try {
      await prepared.assertCurrentPolicy()
      recheckRemoteAction()
      run = await agentManager.startAgent(
        nativeLaunch
          ? { ...startInput, args: nativeLaunch.args }
          : startConfig.args
            ? { ...startInput, args: startConfig.args }
            : startInput
      )
    } catch (error) {
      nativeLaunch?.fail(error)
      await nativeLaunch?.close()
      tokenRegistry.revokeIfMatches(agentId, token)
      await prepared.close()
      throw error
    }
    const liveRun: LiveAgentRun = {
      ...run,
      exitCode: run.status === 'error' ? run.exitCode : null,
      startedAt,
      status: run.status === 'error' ? 'error' : 'starting',
    }
    try {
      if (run.status !== 'error') commitSessionContext()
      store.insertAgentRun(run.runId, agentId, startedAt, run.pid, liveRun.status, liveRun.exitCode)
      prepared.bindRun(run.runId)
    } catch (error) {
      abortedRunIds.add(run.runId)
      registry.clearPendingExitCode(run.runId)
      tokenRegistry.revokeIfMatches(agentId, token)
      try {
        nativeLaunch?.fail(error)
      } finally {
        agentManager.stopRun(run.runId)
        await agentManager.waitForRunExit?.(run.runId)
        await prepared.close()
      }
      throw error
    }
    registry.createExitEntry(run.runId)
    registry.add(liveRun)

    if (run.status === 'error') {
      nativeLaunch?.fail(new Error('Native session process could not start.'))
      store.updatePersistedRun(run.runId, 'error', run.exitCode, Date.now())
      tokenRegistry.revokeIfMatches(agentId, token)
      // Ensure §12 three-state: failed spawn must flip AgentSummary to stopped.
      onAgentExit(workspace.id, agentId)
      registry.resolveExit(run.runId)
      registry.clearPendingExitCode(run.runId)
      return liveRun
    }

    if (nativeLaunch) {
      try {
        await nativeLaunch.verify(agentManager, run.runId)
      } catch (error) {
        try {
          nativeLaunch.fail(error)
        } finally {
          tokenRegistry.revokeIfMatches(agentId, token)
          agentManager.stopRun(run.runId)
          await agentManager.waitForRunExit?.(run.runId)
        }
        throw error
      }
    }

    exitContext.stopSessionCapture = startAgentRunCapture({
      agentId,
      sessionCaptureSnapshot,
      sessionStore,
      startConfig,
      workspace: { ...workspace, path: prepared.cwd },
    })
    void registry.getExitEntry(run.runId)?.promise.then(exitContext.stopSessionCapture)
    const postStartWriter = createPostStartInputWriter(
      agentManager,
      startConfig.interactiveCommand ?? startConfig.command
    )
    queueMicrotask(() => {
      // Native identity hooks do not prove an empty composer or authorize submission.
      if (nativeLaunch) return
      try {
        const injectedRestartMessage = restartPolicy.injectPostStartMessage({
          agentId,
          runId: run.runId,
          startConfig,
          workspace,
          writeToRun: postStartWriter,
        })
        if (
          !startConfig.resumedSessionId &&
          !injectedRestartMessage &&
          agent &&
          agent.role === 'orchestrator' &&
          isInteractiveAgentCommand(startConfig.interactiveCommand ?? startConfig.command)
        ) {
          void discoverWorkspaceDocuments(workspace.path)
            .then((documents) => {
              postStartWriter(
                run.runId,
                buildAgentStartupInstructions({
                  agent,
                  documents,
                  ...(getStartupMemoryDigest
                    ? { memoryDigest: getStartupMemoryDigest(workspace.id, agent, run.runId) }
                    : {}),
                  skillCatalog: skillReadiness.catalog,
                  ...(workspace.language ? { language: workspace.language } : {}),
                  workspace,
                })
              )
            })
            .catch(() => {
              // The workspace may disappear while an agent is starting.
            })
        }
      } catch {
        // The agent may have exited before post-start guidance could be written.
      }
    })

    if (registry.hasPendingExitCode(run.runId)) {
      const exitCode = registry.getPendingExitCode(run.runId) ?? null
      queueMicrotask(() => {
        handleAgentRunExit(exitContext, { exitCode, endedAt: Date.now(), runId: run.runId })
      })
    }

    return liveRun
  }
