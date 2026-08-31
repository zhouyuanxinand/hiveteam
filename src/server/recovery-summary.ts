import type { AgentSummary, WorkspaceLanguage, WorkspaceSummary } from '../shared/types.js'

import { buildAgentSessionBindingMarker } from './agent-startup-instructions.js'
import type { DispatchRecord } from './dispatch-ledger-store.js'
import { getHiveTeamRules } from './hive-team-guidance.js'
import type { RecoveryMessage } from './message-log-store.js'
import { wrapUntrustedPromptData } from './prompt-safety.js'
import { wrapSystemMessage } from './system-message.js'
import { TASKS_RELATIVE_PATH } from './tasks-file.js'

const TASKS_HEAD_LIMIT = 1536

const formatUserInputs = (messages: RecoveryMessage[], language: WorkspaceLanguage) => {
  const userInputs = messages.filter((message) => message.type === 'user_input')
  return userInputs.length > 0
    ? userInputs
        .slice(-5)
        .map((message) => `- user:\n${wrapUntrustedPromptData('report', message.text)}`)
    : [
        language === 'en'
          ? '- (No new user_input in the last hour)'
          : '- （最近 1 小时没有新的 user_input）',
      ]
}

const formatTaskEvents = (
  messages: RecoveryMessage[],
  agent: AgentSummary,
  language: WorkspaceLanguage
) => {
  const taskEvents = messages.filter(
    (message): message is Extract<RecoveryMessage, { type: 'send' | 'report' | 'status' }> => {
      if (agent.role === 'orchestrator') {
        if (message.type === 'send') return message.from === agent.id
        return message.type === 'report' || message.type === 'status'
      }
      if (message.type === 'send') return message.to === agent.id || message.from === agent.id
      return (message.type === 'report' || message.type === 'status') && message.from === agent.id
    }
  )
  return taskEvents.length > 0
    ? taskEvents.slice(-8).map((message) => {
        if (message.type === 'send') {
          return `- send -> ${message.to}:\n${wrapUntrustedPromptData('dispatch-task', message.text)}`
        }
        if (message.type === 'status') {
          return `- status <- ${message.from}:\n${wrapUntrustedPromptData('status', message.text)}`
        }
        const status = message.status ? ` [${message.status}]` : ''
        return `- report <- ${message.from}${status}:\n${wrapUntrustedPromptData('report', message.text)}`
      })
    : [language === 'en' ? '- (No recent task events)' : '- （最近没有任务事件）']
}

const getOpenTaskTargets = (agent: AgentSummary, workers: AgentSummary[]) =>
  agent.role === 'orchestrator' ? workers : [agent]

const formatOpenTasks = (
  dispatches: readonly DispatchRecord[],
  agent: AgentSummary,
  workers: AgentSummary[],
  language: WorkspaceLanguage
) => {
  const targetAgents = getOpenTaskTargets(agent, workers).filter(
    (target) => target.role !== 'orchestrator'
  )
  const targetIds = new Set(targetAgents.map((target) => target.id))
  const queues = new Map<string, DispatchRecord[]>()

  for (const dispatch of dispatches) {
    if (
      (dispatch.status === 'queued' ||
        dispatch.status === 'submitted' ||
        dispatch.status === 'failed') &&
      targetIds.has(dispatch.toAgentId)
    ) {
      const queue = queues.get(dispatch.toAgentId) ?? []
      queue.push(dispatch)
      queues.set(dispatch.toAgentId, queue)
    }
  }

  const lines: string[] = []
  for (const target of targetAgents) {
    const queue = queues.get(target.id) ?? []
    for (const task of queue.slice(-8)) {
      const suffix = task.lastError ? `\nDelivery error: ${task.lastError}` : ''
      lines.push(
        `- ${target.name}:\n${wrapUntrustedPromptData('dispatch-task', task.text)}${suffix}`
      )
    }
    if (target.pendingTaskCount > queue.length) {
      lines.push(
        language === 'en'
          ? `- ${target.name}: ${target.pendingTaskCount - queue.length} pending task(s) without recoverable details`
          : `- ${target.name}: ${target.pendingTaskCount - queue.length} 个 pending 无可恢复详情`
      )
    }
  }

  return lines.length > 0
    ? lines
    : [language === 'en' ? '- (No unfinished tasks)' : '- （当前没有未完成任务）']
}

const formatWorkers = (workers: AgentSummary[], language: WorkspaceLanguage) => {
  if (workers.length === 0)
    return [language === 'en' ? '- No other workers currently' : '- 当前没有其他 worker']
  return workers.map(
    (worker) =>
      `- ${worker.name} (${worker.role}, ${worker.status}, pending_task_count: ${worker.pendingTaskCount})`
  )
}

const getTaskSectionTitle = (agent: AgentSummary, language: WorkspaceLanguage) =>
  language === 'en'
    ? agent.role === 'orchestrator'
      ? '## Tasks you dispatched'
      : '## Tasks recently assigned to you'
    : agent.role === 'orchestrator'
      ? '## 你已派出的任务'
      : '## 最近派给你的任务'

export const buildRecoverySummary = ({
  agent,
  messages,
  openDispatches,
  tasksContent,
  workers,
  workspace,
}: {
  agent: AgentSummary
  messages: RecoveryMessage[]
  openDispatches: readonly DispatchRecord[]
  tasksContent: string
  workers: AgentSummary[]
  workspace: WorkspaceSummary
}) =>
  (() => {
    const language = workspace.language ?? 'zh'
    const english = language === 'en'
    return wrapSystemMessage(
      [
        english
          ? `You are ${agent.name} in ${workspace.name} (${agent.role}).`
          : `你是 ${workspace.name} 的 ${agent.name}（${agent.role}）。`,
        buildAgentSessionBindingMarker({ agent, workspace }),
        english
          ? 'Hive restarted you, but the native session could not be resumed. The following is recovered context.'
          : '你刚被 Hive 重启了，且无法通过原生 session resume 恢复。下面是接力上下文。',
        '',
        english ? '## Conversation with the user in the last hour' : '## 最近 1 小时与 user 的对话',
        ...formatUserInputs(messages, language),
        '',
        getTaskSectionTitle(agent, language),
        ...formatTaskEvents(messages, agent, language),
        '',
        english ? '## Unfinished tasks' : '## 当前未完成任务',
        ...formatOpenTasks(openDispatches, agent, workers, language),
        '',
        english ? `## Current ${TASKS_RELATIVE_PATH} state` : `## 当前 ${TASKS_RELATIVE_PATH} 状态`,
        tasksContent.trim()
          ? wrapUntrustedPromptData('workflow', tasksContent.slice(0, TASKS_HEAD_LIMIT))
          : english
            ? '(empty)'
            : '(空)',
        '',
        english ? '## Active workers' : '## 当前活跃 worker',
        ...formatWorkers(workers, language),
        '',
        agent.role === 'orchestrator'
          ? english
            ? '## Hive worker dispatch rules'
            : '## Hive worker 派单规则'
          : english
            ? '## Hive worker boundaries'
            : '## Hive worker 边界',
        ...getHiveTeamRules(agent, language),
        '',
        english
          ? 'Continue from this context. Ask the user if uncertain.'
          : '请基于此继续。如果不确定，问 user。',
      ].join('\n')
    )
  })()
