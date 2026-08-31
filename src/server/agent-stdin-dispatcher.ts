import type { WorkspaceLanguage } from '../shared/types.js'
import type { AgentManager } from './agent-manager.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import {
  buildWorkerReminderTail,
  getOrchestratorReminderTail,
  ORCHESTRATOR_REMINDER_TAIL,
} from './hive-team-guidance.js'
import { PtyInactiveError } from './http-errors.js'
import type { LiveRunRegistry } from './live-run-registry.js'
import {
  createAwaitablePostStartInputWriter,
  createPostStartInputWriter,
} from './post-start-input-writer.js'
import { sanitizePromptData, wrapUntrustedPromptData } from './prompt-safety.js'

interface AgentStdinDispatcherInput {
  agentManager: AgentManager | undefined
  getDispatchMemoryDigest?: (workspaceId: string, agentId: string, task: string) => string
  getLaunchConfig: (workspaceId: string, agentId: string) => AgentLaunchConfigInput | undefined
  getWorkspaceId: (agentId: string) => string | undefined
  getWorkspaceLanguage?: (workspaceId: string) => WorkspaceLanguage | undefined
  registry: LiveRunRegistry
  syncRun: (run: LiveAgentRun) => LiveAgentRun
}

export const buildOrchestratorReportPayload = (
  workerName: string,
  text: string,
  artifacts: string[],
  language?: WorkspaceLanguage
): string => {
  const english = language === 'en'
  const lines: string[] = [
    english
      ? `[Hive system message: report from @${sanitizePromptData(workerName, 200)}]`
      : `[Hive 系统消息：来自 @${sanitizePromptData(workerName, 200)} 的汇报]`,
    wrapUntrustedPromptData('report', text),
  ]
  for (const artifact of artifacts) lines.push(`artifact: ${sanitizePromptData(artifact, 1_000)}`)
  lines.push('', language ? getOrchestratorReminderTail(language) : ORCHESTRATOR_REMINDER_TAIL, '')
  return lines.join('\n')
}

export const buildOrchestratorStatusPayload = (
  workerName: string,
  text: string,
  artifacts: string[],
  language?: WorkspaceLanguage
): string => {
  const english = language === 'en'
  const lines: string[] = [
    english
      ? `[Hive system message: status update from @${sanitizePromptData(workerName, 200)}]`
      : `[Hive 系统消息：来自 @${sanitizePromptData(workerName, 200)} 的状态更新]`,
    wrapUntrustedPromptData('status', text),
  ]
  for (const artifact of artifacts) lines.push(`artifact: ${sanitizePromptData(artifact, 1_000)}`)
  lines.push('', language ? getOrchestratorReminderTail(language) : ORCHESTRATOR_REMINDER_TAIL, '')
  return lines.join('\n')
}

export const buildOrchestratorUserInputPayload = (
  text: string,
  language?: WorkspaceLanguage
): string =>
  [
    text,
    '',
    language ? getOrchestratorReminderTail(language) : ORCHESTRATOR_REMINDER_TAIL,
    '',
  ].join('\n')

export const buildWorkerDispatchPayload = (
  fromAgentName: string,
  workerDescription: string,
  dispatchId: string,
  text: string,
  memoryDigest?: string,
  sessionBindingMarker?: string,
  language?: WorkspaceLanguage
): string => {
  const english = language === 'en'
  const lines = [
    english
      ? `[Hive system message: dispatch from @${fromAgentName}]`
      : `[Hive 系统消息：来自 @${fromAgentName} 的派单]`,
    '',
    ...(sessionBindingMarker ? [sessionBindingMarker, ''] : []),
    english
      ? `Your role: ${sanitizePromptData(workerDescription, 2_000)}`
      : `你的角色：${sanitizePromptData(workerDescription, 2_000)}`,
    '',
    english ? 'You must follow:' : '你必须遵守：',
    english
      ? `- After completing, failing, blocking, or partially completing the task, run \`team report "<result>" --dispatch ${dispatchId}\``
      : `- 完成、失败、阻塞或部分完成后，执行 \`team report "<result>" --dispatch ${dispatchId}\``,
    english ? '- Do not do unrelated work; report when done' : '- 不要做无关的事，做完就 report',
    '',
    `dispatch_id: ${dispatchId}`,
    '',
    english ? 'Task:' : '任务内容：',
    wrapUntrustedPromptData('dispatch-task', text),
  ]
  if (memoryDigest?.trim()) lines.push('', memoryDigest.trim())
  // Keep the legacy payload's English reminder when callers omit language;
  // workspace-aware callers pass an explicit language for a fully localized
  // dispatch.
  lines.push('', buildWorkerReminderTail(dispatchId, language ?? 'en'), '')
  return lines.join('\n')
}

export const buildWorkerCancelPayload = (dispatchId: string, reason: string): string =>
  [
    `[Hive 系统消息：dispatch ${dispatchId} 已取消]`,
    '',
    '请停止执行这条派单，不要再为它调用 team report。',
    '',
    '取消原因：',
    wrapUntrustedPromptData('status', reason, 2_000),
    '',
  ].join('\n')

export const createAgentStdinDispatcher = ({
  agentManager,
  getDispatchMemoryDigest,
  getLaunchConfig,
  getWorkspaceId,
  getWorkspaceLanguage,
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
        buildOrchestratorReportPayload(
          workerName,
          text,
          artifacts,
          getWorkspaceLanguage?.(workspaceId)
        ),
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
        buildOrchestratorStatusPayload(
          workerName,
          text,
          artifacts,
          getWorkspaceLanguage?.(workspaceId)
        ),
        input
      )
    },
    writeSendPrompt(
      workspaceId: string,
      workerId: string,
      dispatchId: string,
      fromAgentName: string,
      workerDescription: string,
      text: string,
      language?: WorkspaceLanguage
    ) {
      writeToActiveAgentRun(
        workspaceId,
        workerId,
        buildWorkerDispatchPayload(
          fromAgentName,
          workerDescription,
          dispatchId,
          text,
          getDispatchMemoryDigest?.(workspaceId, workerId, text),
          `Hive session binding: workspace_id=${workspaceId}; agent_id=${workerId}`,
          language ?? getWorkspaceLanguage?.(workspaceId)
        ),
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
        buildOrchestratorUserInputPayload(text, getWorkspaceLanguage?.(workspaceId)),
        { requireActiveRun: true }
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
