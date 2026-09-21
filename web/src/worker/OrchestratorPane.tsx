import { Copy, Crown, LoaderCircle, Play, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { useI18n } from '../i18n.js'
import { isRemoteMode } from '../remote/remote-permissions-api.js'
import { ExecutionPolicyButton } from '../security/ExecutionPolicyButton.js'
import { executionCapabilityMessage } from '../security/execution-policy-labels.js'
import { AgentTerminalSurface } from '../terminal/AgentTerminalSurface.js'
import { EmptyState } from '../ui/EmptyState.js'
import { Tooltip } from '../ui/Tooltip.js'
import { NativeSessionButton } from './NativeSessionButton.js'

export type OrchestratorPaneState =
  | { kind: 'starting' }
  | { kind: 'running'; runId: string }
  | { kind: 'stopped' }
  | { kind: 'failed'; error: string; errorCode?: string; missingCapabilities?: string[] }

type OrchestratorPaneProps = {
  workspaceId: string
  state: OrchestratorPaneState
  /** Kept for API stability; M6-B will surface stop via the ⌘K palette. */
  onStop: () => void
  onRemoveWorkspace: () => void
  onStart: () => void
  onRestart: () => void
}

const StartingBody = () => {
  const { t } = useI18n()
  return (
    <div data-testid="orchestrator-starting-body" className="flex flex-1">
      <EmptyState
        icon={<LoaderCircle size={24} className="animate-spin" />}
        title={t('orchestrator.startingTitle')}
        description={t('orchestrator.startingDesc')}
      />
    </div>
  )
}

const StoppedBody = ({ onStart }: { onStart: () => void }) => {
  const { t } = useI18n()
  return (
    <div data-testid="orchestrator-stopped-body" className="flex flex-1">
      <EmptyState
        icon={<Crown size={24} />}
        title={t('orchestrator.stoppedTitle')}
        description={t('orchestrator.stoppedDesc')}
        action={
          <button
            type="button"
            onClick={onStart}
            className="icon-btn icon-btn--primary"
            data-testid="orchestrator-start"
          >
            <Play size={12} aria-hidden /> {t('orchestrator.start')}
          </button>
        }
      />
    </div>
  )
}

const FailedBody = ({
  workspaceId,
  error,
  errorCode,
  missingCapabilities,
  onRemoveWorkspace,
  onRestart,
}: {
  workspaceId: string
  error: string
  errorCode?: string | undefined
  missingCapabilities?: string[] | undefined
  onRemoveWorkspace: () => void
  onRestart: () => void
}) => {
  const { t, language } = useI18n()
  const zh = language === 'zh'
  const policyDenied = errorCode === 'execution_policy_denied'
  const remote = isRemoteMode()
  const [copied, setCopied] = useState(false)
  const copyError = () => {
    void navigator.clipboard
      ?.writeText(error)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }
  return (
    <div
      data-testid="orchestrator-failed-body"
      className="m-auto flex w-full max-w-[480px] flex-col items-center gap-3 px-6 py-8"
    >
      <div
        aria-hidden
        className="flex h-12 w-12 items-center justify-center rounded text-sec"
        style={{ background: 'var(--bg-2)', border: '1px solid var(--border-bright)' }}
      >
        <Crown size={24} />
      </div>
      <div className="text-lg font-semibold text-pri">
        {policyDenied
          ? zh
            ? 'Orchestrator 启动被执行策略阻止'
            : 'Execution policy blocked Orchestrator startup'
          : t('orchestrator.failed')}
      </div>
      {policyDenied ? (
        <div role="alert" className="w-full text-sm text-sec">
          <p>
            {zh
              ? '当前环境无法满足受限执行要求，进程尚未启动。'
              : 'This environment cannot meet the restricted execution requirements. No process was started.'}
          </p>
          {missingCapabilities?.length ? (
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {missingCapabilities.map((capability) => (
                <li key={capability}>{executionCapabilityMessage(capability, zh)}</li>
              ))}
            </ul>
          ) : null}
          <p className="mt-3">
            {remote
              ? zh
                ? '请在本机查看执行权限并处理启动限制。远程页面不能授权无隔离运行。'
                : 'Review execution permissions on the local computer. Remote pages cannot authorize execution without isolation.'
              : zh
                ? '查看执行权限，修正上述条件后重试；如需继续无隔离运行，须由你在本机明确授权。'
                : 'Review execution permissions and resolve these requirements before retrying. Continuing without isolation requires your explicit local authorization.'}
          </p>
        </div>
      ) : null}
      <div className="relative w-full">
        <pre
          data-testid="orchestrator-error-message"
          className="mono w-full max-h-40 overflow-auto whitespace-pre-wrap break-all rounded p-3 pr-9 text-left text-xs"
          style={{
            background: 'color-mix(in oklab, var(--status-red) 8%, var(--bg-2))',
            border: '1px solid color-mix(in oklab, var(--status-red) 24%, transparent)',
            color: 'var(--text-secondary)',
          }}
        >
          {error}
        </pre>
        <Tooltip label={copied ? t('common.copied') : t('common.copyError')}>
          <button
            type="button"
            onClick={copyError}
            aria-label={t('orchestrator.copyErrorAria')}
            className="icon-btn icon-btn--ghost absolute right-1 top-1 h-6 px-1.5"
            data-testid="orchestrator-copy-error"
          >
            <Copy size={12} aria-hidden />
          </button>
        </Tooltip>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        {policyDenied ? (
          <ExecutionPolicyButton
            workspaceId={workspaceId}
            agentId={`${workspaceId}:orchestrator`}
            triggerLabel={zh ? '查看执行权限' : 'Review execution permissions'}
            onAuthorized={onRestart}
          />
        ) : null}
        <button
          type="button"
          onClick={onRestart}
          className={policyDenied ? 'icon-btn' : 'icon-btn icon-btn--primary'}
          data-testid="orchestrator-retry"
        >
          <RotateCcw size={12} aria-hidden /> {t('common.retry')}
        </button>
        <button
          type="button"
          onClick={onRemoveWorkspace}
          className={
            policyDenied ? 'icon-btn icon-btn--ghost text-xs' : 'icon-btn icon-btn--danger'
          }
          data-testid="orchestrator-remove-workspace"
        >
          {t('orchestrator.removeWorkspace')}
        </button>
      </div>
      {/* Header retry was a duplicate; alias kept for back-compat. */}
      <span data-testid="orchestrator-retry-header" className="sr-only">
        {t('common.retry')}
      </span>
    </div>
  )
}

export const OrchestratorPane = ({
  workspaceId,
  state,
  onRemoveWorkspace,
  onRestart,
  onStart,
}: OrchestratorPaneProps) => (
  <div
    className="orchestrator-pane relative flex h-full w-full min-w-0 flex-col"
    style={{
      background: 'var(--bg-crust)',
      borderRight: '1px solid var(--border)',
    }}
    data-testid="orchestrator-terminal-slot"
  >
    <div className="shrink-0 px-3 pt-2">
      <ExecutionPolicyButton
        workspaceId={workspaceId}
        agentId={`${workspaceId}:orchestrator`}
        running={state.kind === 'running'}
      />
      <NativeSessionButton
        workspaceId={workspaceId}
        agentId={`${workspaceId}:orchestrator`}
        running={state.kind === 'running' || state.kind === 'starting'}
      />
    </div>
    {state.kind === 'running' ? (
      <AgentTerminalSurface
        key={state.runId}
        workspaceId={workspaceId}
        agentId={`${workspaceId}:orchestrator`}
        runId={state.runId}
        slot="orch"
      />
    ) : state.kind === 'failed' ? (
      <FailedBody
        workspaceId={workspaceId}
        error={state.error}
        errorCode={state.errorCode}
        missingCapabilities={state.missingCapabilities}
        onRemoveWorkspace={onRemoveWorkspace}
        onRestart={onRestart}
      />
    ) : state.kind === 'stopped' ? (
      <StoppedBody onStart={onStart} />
    ) : (
      <StartingBody />
    )}
  </div>
)
