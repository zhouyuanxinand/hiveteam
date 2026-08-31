import * as Dialog from '@radix-ui/react-dialog'
import {
  AlertTriangle,
  ClipboardList,
  Copy,
  GitBranch,
  RefreshCw,
  TerminalSquare,
  Users,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { type DispatchSummary, getWorkspaceActivity, type WorkspaceActivityBundle } from '../api.js'
import { useI18n } from '../i18n.js'

interface ActivityCenterDrawerProps {
  onClose: () => void
  open: boolean
  workspaceId: string
}

const isOpenDispatch = (dispatch: DispatchSummary) =>
  dispatch.state === 'queued' || dispatch.state === 'submitted' || dispatch.state === 'failed'

const formatAgentId = (
  agentId: string | null,
  workspaceId: string,
  workers: WorkspaceActivityBundle['workers']
) => {
  if (!agentId || agentId === `${workspaceId}:orchestrator`) return 'Orchestrator'
  return workers.find((worker) => worker.id === agentId)?.name ?? agentId
}

const stateKey = (state: DispatchSummary['state']) => {
  if (state === 'failed') return 'activity.state.failed' as const
  if (state === 'reported') return 'activity.state.reported' as const
  if (state === 'cancelled') return 'activity.state.cancelled' as const
  if (state === 'submitted') return 'activity.state.submitted' as const
  return 'activity.state.queued' as const
}

export const ActivityCenterDrawer = ({ onClose, open, workspaceId }: ActivityCenterDrawerProps) => {
  const { language, t } = useI18n()
  const [bundle, setBundle] = useState<WorkspaceActivityBundle | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<'report' | 'diagnostics' | null>(null)

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    [language]
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setBundle(await getWorkspaceActivity(workspaceId))
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    if (!open) return
    setCopied(null)
    void load()
  }, [load, open])

  const copyText = async (kind: 'report' | 'diagnostics') => {
    if (!bundle) return
    const openDispatches = bundle.dispatches.filter(isOpenDispatch)
    const report = [
      `HiveTeam ${t('activity.teamReport')} · ${bundle.workspace.name}`,
      `${t('activity.generatedAt')}: ${dateFormatter.format(bundle.generatedAt)}`,
      '',
      `${t('activity.workers')}: ${bundle.workers.length}`,
      `${t('activity.openDispatches')}: ${openDispatches.length}`,
      `${t('activity.messages')}: ${bundle.messages.length}`,
      '',
      ...bundle.workers.map(
        (worker) =>
          `- ${worker.name} · ${worker.role} · ${worker.status} · ${t('worker.pendingDispatch', { count: worker.pendingTaskCount })}`
      ),
      '',
      ...openDispatches.map((dispatch) => {
        const from = formatAgentId(dispatch.fromAgentId, workspaceId, bundle.workers)
        const to = formatAgentId(dispatch.toAgentId, workspaceId, bundle.workers)
        return `- [${t(stateKey(dispatch.state))}] ${from} → ${to}: ${dispatch.text}`
      }),
    ].join('\n')
    const text = kind === 'report' ? report : JSON.stringify(bundle, null, 2)
    try {
      await navigator.clipboard.writeText(text)
      setCopied(kind)
      window.setTimeout(() => setCopied((current) => (current === kind ? null : current)), 1800)
    } catch (copyError: unknown) {
      setError(copyError instanceof Error ? copyError.message : String(copyError))
    }
  }

  const gitStatus = bundle?.git && 'workspaceId' in bundle.git ? bundle.git : null
  const openDispatchCount = bundle?.dispatches.filter(isOpenDispatch).length ?? 0

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="app-overlay activity-center-overlay fixed inset-0 z-40" />
        <Dialog.Content
          className="activity-center-drawer fixed z-50 flex flex-col border-l"
          data-testid="activity-center-drawer"
        >
          <header className="activity-center-header">
            <div className="flex min-w-0 items-center gap-3">
              <div className="activity-center-heading-icon" aria-hidden>
                <ClipboardList size={18} />
              </div>
              <div className="min-w-0">
                <Dialog.Title className="text-lg font-semibold text-pri">
                  {t('activity.title')}
                </Dialog.Title>
                <Dialog.Description className="mt-0.5 text-xs text-ter">
                  {t('activity.description')}
                </Dialog.Description>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="activity-center-icon-button"
                onClick={() => void load()}
                disabled={loading}
                aria-label={t('activity.refresh')}
                title={t('activity.refresh')}
              >
                <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} aria-hidden />
              </button>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="activity-center-icon-button"
                  aria-label={t('common.close')}
                >
                  <X size={16} aria-hidden />
                </button>
              </Dialog.Close>
            </div>
          </header>

          <div className="activity-center-actions">
            <button
              type="button"
              className="icon-btn icon-btn--primary"
              disabled={!bundle || loading}
              onClick={() => void copyText('report')}
              data-testid="activity-copy-report"
            >
              <Copy size={14} aria-hidden />
              {copied === 'report' ? t('activity.copied') : t('activity.copyReport')}
            </button>
            <button
              type="button"
              className="icon-btn"
              disabled={!bundle || loading}
              onClick={() => void copyText('diagnostics')}
              data-testid="activity-copy-diagnostics"
            >
              <Copy size={14} aria-hidden />
              {copied === 'diagnostics' ? t('activity.copied') : t('activity.copyDiagnostics')}
            </button>
          </div>

          {error ? (
            <div className="activity-center-message activity-center-message--error" role="alert">
              <AlertTriangle size={14} aria-hidden /> {error}
            </div>
          ) : null}

          <div className="activity-center-body scroll-y">
            {loading && !bundle ? (
              <div className="activity-center-empty">
                <RefreshCw size={20} className="animate-spin" aria-hidden />
                {t('activity.loading')}
              </div>
            ) : bundle ? (
              <>
                <section className="activity-center-summary" aria-label={t('activity.title')}>
                  <div>
                    <Users size={14} aria-hidden />
                    <strong>{bundle.workers.length}</strong>
                    <span>{t('activity.workers')}</span>
                  </div>
                  <div>
                    <ClipboardList size={14} aria-hidden />
                    <strong>{openDispatchCount}</strong>
                    <span>{t('activity.openDispatches')}</span>
                  </div>
                  <div>
                    <TerminalSquare size={14} aria-hidden />
                    <strong>{bundle.terminalRuns.length}</strong>
                    <span>{t('activity.terminals')}</span>
                  </div>
                </section>

                <section className="activity-center-section">
                  <div className="activity-center-section-heading">
                    <h3>{t('activity.dispatches')}</h3>
                    {gitStatus?.branch ? (
                      <span>
                        <GitBranch size={12} aria-hidden /> {gitStatus.branch}
                      </span>
                    ) : null}
                  </div>
                  {bundle.dispatches.length === 0 ? (
                    <p className="activity-center-muted">{t('activity.noDispatches')}</p>
                  ) : (
                    <div className="activity-center-list">
                      {bundle.dispatches.slice(0, 50).map((dispatch) => (
                        <article className="activity-center-dispatch" key={dispatch.id}>
                          <div className="activity-center-dispatch-topline">
                            <span
                              className={`activity-center-state activity-center-state--${dispatch.state}`}
                            >
                              {t(stateKey(dispatch.state))}
                            </span>
                            <time dateTime={new Date(dispatch.createdAt).toISOString()}>
                              {dateFormatter.format(dispatch.createdAt)}
                            </time>
                          </div>
                          <div className="activity-center-dispatch-route">
                            {formatAgentId(dispatch.fromAgentId, workspaceId, bundle.workers)}
                            <span aria-hidden>→</span>
                            {formatAgentId(dispatch.toAgentId, workspaceId, bundle.workers)}
                          </div>
                          <p title={dispatch.text}>{dispatch.text}</p>
                          {dispatch.lastError ? <small>{dispatch.lastError}</small> : null}
                          {!dispatch.lastError && dispatch.reportDelivery?.lastError ? (
                            <small>
                              {t('activity.reportDeliveryQueued', {
                                error: dispatch.reportDelivery.lastError,
                              })}
                            </small>
                          ) : null}
                        </article>
                      ))}
                    </div>
                  )}
                </section>

                <section className="activity-center-section">
                  <div className="activity-center-section-heading">
                    <h3>{t('activity.messages')}</h3>
                  </div>
                  {bundle.messages.length === 0 ? (
                    <p className="activity-center-muted">{t('activity.noMessages')}</p>
                  ) : (
                    <div className="activity-center-message-list">
                      {bundle.messages
                        .slice(-20)
                        .reverse()
                        .map((message) => (
                          <div
                            className="activity-center-message-row"
                            key={`${message.type}-${message.createdAt}-${message.from ?? ''}-${message.to ?? ''}-${message.text}`}
                          >
                            <span className="activity-center-message-type">{message.type}</span>
                            <span className="activity-center-message-text">{message.text}</span>
                            <time>{dateFormatter.format(message.createdAt)}</time>
                          </div>
                        ))}
                    </div>
                  )}
                </section>

                <section className="activity-center-section activity-center-git-section">
                  <div className="activity-center-section-heading">
                    <h3>{t('activity.git')}</h3>
                  </div>
                  {gitStatus ? (
                    <p className="activity-center-muted">
                      {gitStatus.branch ?? t('activity.noGit')} ·{' '}
                      {gitStatus.isDirty ? t('activity.gitDirty') : t('activity.gitClean')} ·{' '}
                      {bundle.gitCommits.length} {t('activity.commits')}
                    </p>
                  ) : (
                    <p className="activity-center-muted">
                      {bundle.git?.error ?? t('activity.noGit')}
                    </p>
                  )}
                </section>
              </>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
