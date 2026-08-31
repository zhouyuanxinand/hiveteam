import type { AgentSummary, WorkspaceLanguage, WorkspaceSummary } from '../shared/types.js'
import {
  formatWorkspaceDocumentContext,
  type WorkspaceDocumentSummary,
} from '../shared/workspace-documents.js'

import { getHiveTeamRules } from './hive-team-guidance.js'
import { getLocalizedAgentDescription } from './role-templates.js'
import { TASKS_RELATIVE_PATH } from './tasks-file.js'

export const buildAgentSessionBindingMarker = ({
  agent,
  workspace,
}: {
  agent: AgentSummary
  workspace: WorkspaceSummary
}) => `Hive session binding: workspace_id=${workspace.id}; agent_id=${agent.id}`

export const buildAgentLegacyIdentityMarker = ({
  agent,
  language = 'zh',
  workspace,
}: {
  agent: AgentSummary
  language?: WorkspaceLanguage
  workspace: WorkspaceSummary
}) =>
  language === 'en'
    ? `You are ${agent.name} (${agent.role}) in ${workspace.name}.`
    : `你是 ${workspace.name} 的 ${agent.name}（${agent.role}）。`

export const buildAgentStartupInstructions = ({
  agent,
  documents,
  language,
  memoryDigest,
  workspace,
}: {
  agent: AgentSummary
  documents?: WorkspaceDocumentSummary[]
  memoryDigest?: string
  language?: WorkspaceLanguage
  workspace: WorkspaceSummary
}) => {
  const workspaceLanguage: WorkspaceLanguage = language ?? workspace.language ?? 'zh'
  const english = workspaceLanguage === 'en'
  const description = getLocalizedAgentDescription(agent, workspaceLanguage)
  const lines = [
    english ? '[Hive system message: startup instructions]' : '[Hive 系统消息：启动说明]',
    '',
    buildAgentLegacyIdentityMarker({ agent, language: workspaceLanguage, workspace }),
    english ? `Current workspace: ${workspace.name}` : `当前 workspace: ${workspace.name}`,
    english ? `Project path: ${workspace.path}` : `项目路径: ${workspace.path}`,
    buildAgentSessionBindingMarker({ agent, workspace }),
    '',
    english ? `Your role: ${description}` : `你的角色：${description}`,
    '',
  ]

  const documentContext = formatWorkspaceDocumentContext(documents ?? [], workspaceLanguage)
  if (documentContext) lines.push(documentContext, '')

  if (agent.role === 'orchestrator') {
    lines.push(
      english ? 'Responsibilities:' : '你的职责：',
      english
        ? '- Respond to the user, clarify goals, and split work into tasks.'
        : '- 直接响应 user，澄清需求并拆解任务',
      english ? `- Maintain ${TASKS_RELATIVE_PATH}.` : `- 维护 ${TASKS_RELATIVE_PATH}`,
      english
        ? '- Dispatch by worker name and use reports to decide the next step.'
        : '- 按 worker 名称派单，并根据汇报推进下一步',
      '',
      english ? 'Available team commands:' : '可用 team 命令：',
      '- team list',
      '- team guide <core|dispatch|tasks|memory|workflow|member>',
      '- team send "<worker-name>" "<task>"',
      '- team cancel --dispatch <id> "<reason>"',
      '',
      english
        ? 'Use the worker name when dispatching; do not use the worker id.'
        : '派单时必须使用 worker name，不要使用 worker id。',
      english
        ? 'Use the dispatch id when cancelling an unfinished dispatch.'
        : '取消未完成派单时必须使用 dispatch id。',
      english
        ? 'Before non-trivial work, use `team guide <topic>` for focused runtime rules; `.hive/PROTOCOL.md` contains the full protocol.'
        : '处理非简单任务前，使用 `team guide <topic>` 获取对应运行规则；完整协议见 `.hive/PROTOCOL.md`。',
      '',
      english ? 'Hive worker dispatch rules:' : 'Hive worker 派单规则：',
      ...getHiveTeamRules(agent, workspaceLanguage)
    )
  } else {
    lines.push(
      english ? 'Available team commands:' : '可用 team 命令：',
      english
        ? '- team report "<result>" [--dispatch <id>] [--artifact <path>]    report completion/failure/blockage'
        : '- team report "<完整汇报>" [--dispatch <id>] [--artifact <path>]    完成/失败/阻塞汇报',
      english
        ? '- team report --stdin [--dispatch <id>] [--artifact <path>]         same, read a multi-line body from stdin'
        : '- team report --stdin [--dispatch <id>] [--artifact <path>]         同上，从 stdin 读正文（适合多行/含引号/特殊字符）',
      english
        ? '- team status "<current state>" [--artifact <path>]                  progress/readiness/status update'
        : '- team status "<当前状态>" [--artifact <path>]                       中段进度/待命/接入状态',
      english
        ? '- team status --stdin [--artifact <path>]                            same, read the body from stdin'
        : '- team status --stdin [--artifact <path>]                          同上，从 stdin 读正文',
      english
        ? '- team list                                                        list workspace workers and status'
        : '- team list                                                        查看 workspace 内的 worker（含状态）',
      english
        ? '- team --help                                                      command syntax only; never a report'
        : '- team --help                                                      仅查命令用法；**不是**汇报手段',
      '',
      english ? 'Syntax notes:' : '语法要点：',
      english
        ? '- The body is the first positional argument; flag order is flexible: `team report "result" --dispatch X` and `team report --dispatch X "result"` both work.'
        : '- 正文是第一个 positional argument，flag 顺序任意：`team report "结论" --dispatch X` 和 `team report --dispatch X "结论"` 都成立。',
      english
        ? "- For multi-line bodies, quotes, shell metacharacters, or heredocs, always use `--stdin` with a *quoted* heredoc (`<<'EOF'`) so the shell does not expand $vars, backticks, or substitutions:"
        : "- 长正文（多行 / 含引号 / shell 特殊字符 / heredoc）一律走 `--stdin`，并用 *quoted* heredoc（`<<'EOF'`）防止 shell 展开 $vars / 反引号 / 命令替换：",
      english
        ? "  Example: `team report --stdin --dispatch <id> <<'EOF'`"
        : "  例：`team report --stdin --dispatch <id> <<'EOF'`",
      english
        ? '       `... preserve $VAR, `backtick`, and "quotes" literally ...`'
        : '       `... 长报告（含 $VAR、`backtick`、"引号" 都按字面量保留）...`',
      '       `EOF`',
      english
        ? '- CLI errors also print USAGE; use it to correct the arguments.'
        : '- CLI 报错会同时打印 USAGE，可直接对照修正参数。',
      '',
      english
        ? 'After completing a task, you must run `team report "<result>"`.'
        : '完成任务后必须执行 `team report "<结论>"`。',
      english
        ? 'For failure, blockage, or partial completion, report with `team report "<current state and reason>"`.'
        : '失败、阻塞或部分完成也用 `team report "<当前状态与原因>"` 汇报。',
      english
        ? 'When no task is active, use `team status "<current state>"` to report readiness or blockage.'
        : '没有进行中的任务时，用 `team status "<当前状态>"` 汇报接入、待命或阻塞状态。',
      english
        ? 'Do not call `team send`; workers cannot dispatch to one another.'
        : '不要调用 team send；worker 之间不能直接派单。',
      '',
      english ? 'Hive worker boundaries:' : 'Hive worker 边界：',
      ...getHiveTeamRules(agent, workspaceLanguage)
    )
  }

  if (memoryDigest?.trim()) {
    lines.push('', memoryDigest.trim())
  }

  lines.push('')
  return lines.join('\n')
}
