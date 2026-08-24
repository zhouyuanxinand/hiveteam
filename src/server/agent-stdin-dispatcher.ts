import type { AgentManager } from './agent-manager.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import { buildWorkerReminderTail, ORCHESTRATOR_REMINDER_TAIL } from './hive-team-guidance.js'
import { PtyInactiveError } from './http-errors.js'
import type { LiveRunRegistry } from './live-run-registry.js'
import {
  createAwaitablePostStartInputWriter,
  createPostStartInputWriter,
} from './post-start-input-writer.js'

interface AgentStdinDispatcherInput {
  agentManager: AgentManager | undefined
  getLaunchConfig: (workspaceId: string, agentId: string) => AgentLaunchConfigInput | undefined
  getWorkspaceId: (agentId: string) => string | undefined
  registry: LiveRunRegistry
  syncRun: (run: LiveAgentRun) => LiveAgentRun
}

export const buildOrchestratorReportPayload = (
  workerName: string,
  text: string,
  artifacts: string[]
): string => {
  const lines: string[] = [`[Hive 系统消息：来自 @${workerName} 的汇报]`, text]
  for (const artifact of artifacts) lines.push(`artifact: ${artifact}`)
  lines.push('', ORCHESTRATOR_REMINDER_TAIL, '')
  return lines.join('\n')
}

export const buildOrchestratorStatusPayload = (
  workerName: string,
  text: string,
  artifacts: string[]
): string => {
  const lines: string[] = [`[Hive 系统消息：来自 @${workerName} 的状态更新]`, text]
  for (const artifact of artifacts) lines.push(`artifact: ${artifact}`)
  lines.push('', ORCHESTRATOR_REMINDER_TAIL, '')
  return lines.join('\n')
}

export const buildOrchestratorUserInputPayload = (text: string): string =>
  [text, '', ORCHESTRATOR_REMINDER_TAIL, ''].join('\n')

export const buildWorkerDispatchPayload = (
  fromAgentName: string,
  workerDescription: string,
  dispatchId: string,
  text: string
): string =>
  [
    `[Hive 系统消息：来自 @${fromAgentName} 的派单]`,
    '',
    `你的角色：${workerDescription}`,
    '',
    '你必须遵守：',
    `- 完成、失败、阻塞或部分完成后，执行 \`team report "<result>" --dispatch ${dispatchId}\``,
    '- 不要做无关的事，做完就 report',
    '',
    `dispatch_id: ${dispatchId}`,
    '',
    '任务内容：',
    text,
    '',
    buildWorkerReminderTail(dispatchId),
    '',
  ].join('\n')

export const buildWorkerCancelPayload = (dispatchId: string, reason: string): string =>
  [
    `[Hive 系统消息：dispatch ${dispatchId} 已取消]`,
    '',
    '请停止执行这条派单，不要再为它调用 team report。',
    '',
    '取消原因：',
    reason,
    '',
  ].join('\n')

export const createAgentStdinDispatcher = ({
  agentManager,
  getLaunchConfig,
  getWorkspaceId,
  registry,
  syncRun,
}: AgentStdinDispatcherInput) => {
  const findActiveAgentRun = (workspaceId: string, agentId: string) =>
    registry
      .list()
      .filter((item) => item.agentId === agentId && getWorkspaceId(item.agentId) === workspaceId)
      .sort((left, right) => right.startedAt - left.startedAt)
      .find((item) => {
        const status = syncRun(item).status
        return status === 'starting' || status === 'running'
      })

  const writeToActiveAgentRun = (
    workspaceId: string,
    agentId: string,
    text: string,
    input: { requireActiveRun?: boolean } = {}
  ) => {
    const run = findActiveAgentRun(workspaceId, agentId)
    if (!run) {
      if (input.requireActiveRun) {
        throw new PtyInactiveError(`No active run for agent: ${agentId}`)
      }
      return
    }

    try {
      const config = getLaunchConfig(workspaceId, agentId)
      if (agentManager && config) {
        createPostStartInputWriter(agentManager, config.interactiveCommand ?? config.command)(
          run.runId,
          text
        )
      } else {
        agentManager?.writeInput(run.runId, text)
      }
    } catch (error) {
      throw new PtyInactiveError(error instanceof Error ? error.message : String(error))
    }
  }

  const deliverToActiveAgentRun = (
    workspaceId: string,
    agentId: string,
    text: string,
    input: { requireActiveRun?: boolean } = {}
  ): Promise<void> => {
    const run = findActiveAgentRun(workspaceId, agentId)
    if (!run) {
      if (input.requireActiveRun) {
        return Promise.reject(new PtyInactiveError(`No active run for agent: ${agentId}`))
      }
      return Promise.resolve()
    }

    try {
      const config = getLaunchConfig(workspaceId, agentId)
      if (agentManager && config) {
        return createAwaitablePostStartInputWriter(
          agentManager,
          config.interactiveCommand ?? config.command
        )(run.runId, text).catch((error: unknown) => {
          throw new PtyInactiveError(error instanceof Error ? error.message : String(error))
        })
      }
      if (!agentManager) {
        return Promise.reject(new PtyInactiveError(`Agent manager is unavailable for: ${agentId}`))
      }
      agentManager.writeInput(run.runId, text)
      return Promise.resolve()
    } catch (error) {
      return Promise.reject(
        new PtyInactiveError(error instanceof Error ? error.message : String(error))
      )
    }
  }

  return {
    writeReportPrompt(
      workspaceId: string,
      workerName: string,
      text: string,
      artifacts: string[],
      input: { requireActiveRun?: boolean } = {}
    ) {
      writeToActiveAgentRun(
        workspaceId,
        `${workspaceId}:orchestrator`,
        buildOrchestratorReportPayload(workerName, text, artifacts),
        input
      )
    },
    writeStatusPrompt(
      workspaceId: string,
      workerName: string,
      text: string,
      artifacts: string[],
      input: { requireActiveRun?: boolean } = {}
    ) {
      writeToActiveAgentRun(
        workspaceId,
        `${workspaceId}:orchestrator`,
        buildOrchestratorStatusPayload(workerName, text, artifacts),
        input
      )
    },
    writeSendPrompt(
      workspaceId: string,
      workerId: string,
      dispatchId: string,
      fromAgentName: string,
      workerDescription: string,
      text: string
    ) {
      writeToActiveAgentRun(
        workspaceId,
        workerId,
        buildWorkerDispatchPayload(fromAgentName, workerDescription, dispatchId, text),
        { requireActiveRun: true }
      )
    },
    writeCancelPrompt(
      workspaceId: string,
      workerId: string,
      dispatchId: string,
      reason: string,
      input: { requireActiveRun?: boolean } = {}
    ) {
      writeToActiveAgentRun(
        workspaceId,
        workerId,
        buildWorkerCancelPayload(dispatchId, reason),
        input
      )
    },
    writeUserInputPrompt(workspaceId: string, text: string) {
      writeToActiveAgentRun(
        workspaceId,
        `${workspaceId}:orchestrator`,
        buildOrchestratorUserInputPayload(text)
      )
    },
    deliverSystemMessageToAgent(
      workspaceId: string,
      agentId: string,
      text: string,
      input: { requireActiveRun?: boolean } = {}
    ) {
      return deliverToActiveAgentRun(workspaceId, agentId, text, input)
    },
  }
}
