import type { AgentSummary, WorkspaceLanguage, WorkspaceSummary } from '../shared/types.js'

import { getHiveTeamRules } from './hive-team-guidance.js'
import type { RecoveryMessage } from './message-log-store.js'
import { wrapUntrustedPromptData } from './prompt-safety.js'
import { wrapSystemMessage } from './system-message.js'
import { TASKS_RELATIVE_PATH } from './tasks-file.js'

const TASKS_HEAD_LIMIT = 1024

const formatWorkers = (workers: AgentSummary[], language: WorkspaceLanguage) => {
  if (workers.length === 0)
    return [language === 'en' ? '- No other workers currently' : '- 当前没有其他 worker']
  return workers.map(
    (worker) =>
      `- ${worker.name} (${worker.role}, ${worker.status}, pending_task_count: ${worker.pendingTaskCount})`
  )
}

const formatRestartWindow = (messages: RecoveryMessage[], language: WorkspaceLanguage) => {
  const sends = messages.filter(
    (message): message is Extract<RecoveryMessage, { type: 'send' }> => {
      return message.type === 'send'
    }
  )
  if (sends.length === 0) {
    return [
      language === 'en' ? '- No dispatches were sent during the restart' : '- 重启期间未派新单',
    ]
  }
  return sends
    .slice(-5)
    .map(
      (message) =>
        `- send -> ${message.to}:\n${wrapUntrustedPromptData('dispatch-task', message.text)}`
    )
}

export const buildEnvSyncMessage = ({
  agent,
  tasksContent,
  workers,
  workspace,
  restartWindowMessages,
}: {
  agent: AgentSummary
  tasksContent: string
  workers: AgentSummary[]
  workspace: WorkspaceSummary
  restartWindowMessages: RecoveryMessage[]
}) =>
  (() => {
    const language = workspace.language ?? 'zh'
    const english = language === 'en'
    return wrapSystemMessage(
      [
        english
          ? 'Hive restarted your agent. Environment changes during the restart:'
          : '你刚被 Hive 重启了。期间环境变化：',
        english ? `- Current workspace: ${workspace.name}` : `- 当前 workspace: ${workspace.name}`,
        english ? '- Current workers:' : '- 现有 worker:',
        ...formatWorkers(workers, language),
        english
          ? `- Current ${TASKS_RELATIVE_PATH} content:`
          : `- ${TASKS_RELATIVE_PATH} 当前内容:`,
        tasksContent.trim()
          ? wrapUntrustedPromptData('workflow', tasksContent.slice(0, TASKS_HEAD_LIMIT))
          : english
            ? '(empty)'
            : '(空)',
        ...formatRestartWindow(restartWindowMessages, language),
        agent.role === 'orchestrator'
          ? english
            ? '- Hive worker dispatch rules:'
            : '- Hive worker 派单规则:'
          : english
            ? '- Hive worker boundaries:'
            : '- Hive worker 边界:',
        ...getHiveTeamRules(agent, language).map((rule) => `  - ${rule}`),
        english
          ? `Continue. If uncertain, use team list / Read ${TASKS_RELATIVE_PATH} to inspect or ask the user.`
          : `请继续。如果不确定，用 team list / Read ${TASKS_RELATIVE_PATH} 自查或问 user。`,
      ].join('\n')
    )
  })()
