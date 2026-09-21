import { useState } from 'react'
import type { CliReadiness } from '../../../src/shared/cli-readiness.js'
import { apiFetch, readErrorMessage } from '../api.js'
import { useI18n } from '../i18n.js'
import { isRemoteMode } from '../remote/remote-permissions-api.js'

const stateLabels = {
  missing: ['未找到命令', 'Command missing'],
  unverified: ['已找到，尚未完整验证', 'Found; not fully verified'],
  incompatible: ['当前启动条件不兼容', 'Current launch requirements are incompatible'],
  authentication_required: ['需要 CLI 登录', 'CLI login required'],
  ready: ['检查通过，可尝试启动', 'Checks passed; ready to try starting'],
  failed: ['检测失败', 'Check failed'],
}
export const WorkspaceOnboardingPanel = ({
  workspaceId,
  onOpenSkills,
  onFirstTask,
}: {
  workspaceId: string
  onOpenSkills?: (() => void) | undefined
  onFirstTask: () => void
}) => {
  const { language } = useI18n(),
    zh = language === 'zh'
  const [view, setView] = useState<CliReadiness | null>(null)
  const [mode, setMode] = useState<string | null>(null)
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false)
  const path = `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(`${workspaceId}:orchestrator`)}/readiness`
  const load = async (probe = false) => {
    if (busy) return
    setBusy(true)
    setError('')
    setCopied(false)
    try {
      const [diagnostic, initialization] = await Promise.all([
        apiFetch(
          path,
          probe && view?.cli_fingerprint
            ? {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ expected_cli_fingerprint: view.cli_fingerprint }),
              }
            : {}
        ),
        apiFetch(`/api/ui/workspaces/${workspaceId}/onboarding`),
      ])
      if (!diagnostic.ok)
        throw new Error(await readErrorMessage(diagnostic, 'Readiness check failed'))
      if (!initialization.ok)
        throw new Error(
          await readErrorMessage(initialization, 'Workspace initialization could not be read')
        )
      setView((await diagnostic.json()) as CliReadiness)
      setMode(
        ((await initialization.json()) as { initialization: { mode: string } | null })
          .initialization?.mode ?? null
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  if (isRemoteMode()) return null
  return (
    <details
      className="workspace-onboarding"
      onToggle={(event) => {
        if (event.currentTarget.open && !view && !busy) void load()
      }}
    >
      <summary>{zh ? '开始使用与 CLI 检查' : 'Getting started and CLI checks'}</summary>
      <div className="workspace-onboarding-body">
        <p>
          {mode === 'basic'
            ? zh
              ? '创建时选择了基础模式，未安装默认技能包。已有技能与文件保留。'
              : 'Created in basic mode without installing default packs. Existing skills and files were preserved.'
            : mode === 'packs'
              ? zh
                ? '创建时使用默认团队技能包模式。'
                : 'Created with the default skill-pack flow.'
              : zh
                ? '创建工作区、检查 CLI、在 Orchestrator 终端输入第一个任务。'
                : 'Create a workspace, check the CLI, then enter your first task in the Orchestrator terminal.'}
        </p>
        <div className="delivery-history-controls">
          <button type="button" onClick={onFirstTask}>
            {zh ? '前往第一个任务' : 'Go to your first task'}
          </button>
          {onOpenSkills ? (
            <button type="button" onClick={onOpenSkills}>
              {zh ? '管理团队技能包' : 'Manage team skill packs'}
            </button>
          ) : null}
          <button type="button" disabled={busy} onClick={() => void load()}>
            {zh ? '刷新启动检查' : 'Refresh startup checks'}
          </button>
          {view?.probe_available ? (
            <button type="button" disabled={busy} onClick={() => void load(true)}>
              {zh ? '通过 CLI 检查登录状态' : 'Check login through the CLI'}
            </button>
          ) : null}
          {view ? (
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard
                  .writeText(JSON.stringify(view, null, 2))
                  .then(() => setCopied(true))
                  .catch((cause: unknown) =>
                    setError(cause instanceof Error ? cause.message : String(cause))
                  )
              }}
            >
              {copied ? (zh ? '已复制' : 'Copied') : zh ? '复制诊断' : 'Copy diagnostics'}
            </button>
          ) : null}
        </div>
        {busy ? <p role="status">{zh ? '正在检查…' : 'Checking…'}</p> : null}
        {error ? (
          <p role="alert" className="dispatch-report-error">
            {error}
          </p>
        ) : null}
        {view ? (
          <>
            <p role="status">
              <strong>{stateLabels[view.state][zh ? 0 : 1]}</strong>
            </p>
            <dl className="dispatch-integration-paths">
              <dt>{zh ? '命令与版本' : 'Command and version'}</dt>
              <dd>
                {view.command_found
                  ? (view.version ?? (zh ? '已找到；版本未验证' : 'Found; version unverified'))
                  : zh
                    ? '未找到'
                    : 'Not found'}
              </dd>
              <dt>{zh ? '启动参数' : 'Launch parameters'}</dt>
              <dd>
                {view.parameters === 'supported'
                  ? zh
                    ? '已验证范围内'
                    : 'Within the verified profile'
                  : view.parameters === 'unsupported'
                    ? zh
                      ? '超出已验证范围'
                      : 'Outside the verified profile'
                    : zh
                      ? '未知'
                      : 'Unknown'}
              </dd>
              <dt>{zh ? '登录状态' : 'Login state'}</dt>
              <dd>
                {view.authentication === 'present'
                  ? zh
                    ? 'CLI 检测到认证信息（不证明模型请求成功）'
                    : 'CLI found authentication; model requests are not verified'
                  : view.authentication === 'missing'
                    ? zh
                      ? '请先在对应 CLI 环境登录'
                      : 'Log in to the relevant CLI environment first'
                    : zh
                      ? '未检查，请在 CLI 内确认登录'
                      : 'Not checked; confirm login in the CLI'}
              </dd>
              <dt>{zh ? '执行权限' : 'Execution permissions'}</dt>
              <dd>
                {view.execution === 'allowed'
                  ? zh
                    ? '已按当前策略授权'
                    : 'Authorized by the current policy'
                  : view.execution === 'pending'
                    ? zh
                      ? '启动时仍需核验'
                      : 'Still requires launch-time verification'
                    : zh
                      ? '当前受阻，请查看执行权限面板'
                      : 'Blocked; review the execution permissions panel'}
              </dd>
            </dl>
            <p className="dispatch-report-note">
              {zh
                ? '检查不发送模型请求。登录检测仅使用已认证版本的固定命令；原始输出与认证信息不会显示或持久化。首次报告时间在真实报告发生前保持未知。'
                : 'Checks send no model prompt. Login checks use a fixed command in verified releases; raw output and authentication details are not displayed or stored. Time to first report remains unknown until a report is received.'}
            </p>
            <details>
              <summary>{zh ? '诊断原因代码' : 'Diagnostic reason codes'}</summary>
              <ul>
                {view.reason_codes.map((code) => (
                  <li key={code}>
                    <code>{code}</code>
                  </li>
                ))}
              </ul>
            </details>
          </>
        ) : null}
      </div>
    </details>
  )
}
