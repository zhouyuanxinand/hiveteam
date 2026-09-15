import * as Dialog from '@radix-ui/react-dialog'
import { Check, Play, RefreshCw, Square, X } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { DispatchVerificationView } from '../../../src/shared/verification.js'
import type { DispatchSummary } from '../api.js'
import { useI18n } from '../i18n.js'
import { DispatchIntegrationPanel } from './DispatchIntegrationPanel.js'
import { DispatchPullRequestPanel } from './DispatchPullRequestPanel.js'
import {
  getDispatchVerifications,
  startDispatchVerification,
  updateDispatchVerification,
} from './verification-api.js'

export type VerificationPanel = 'verification' | 'integration' | 'publication' | 'branch'

import { WorkerBranchPanel } from './WorkerBranchPanel.js'

export const DispatchVerificationDialog = ({
  dispatch,
  onClose,
  onChanged,
  initialPanel = 'verification',
}: {
  dispatch: DispatchSummary
  onClose: () => void
  onChanged: () => void
  initialPanel?: VerificationPanel
}) => {
  const { t } = useI18n()
  const commandId = useId()
  const [view, setView] = useState<DispatchVerificationView | null>(null)
  const [panel, setPanel] = useState<VerificationPanel>(initialPanel)
  const panelInitialized = useRef(false)
  const [command, setCommand] = useState('')
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const error = actionError ?? loadError
  const generation = useRef(0)
  const pendingLoads = useRef(0)
  const commandInitialized = useRef(false)
  const load = useCallback(async () => {
    const current = ++generation.current
    pendingLoads.current += 1
    try {
      const next = await getDispatchVerifications(dispatch.workspaceId, dispatch.id)
      if (current !== generation.current) return
      setView(next)
      if (!panelInitialized.current) {
        if (next.isolated && next.unavailableReason) setPanel('branch')
        panelInitialized.current = true
      }
      setLoadError(null)
      if (!commandInitialized.current) {
        setCommand(next.runs[0]?.command ?? '')
        commandInitialized.current = true
      }
    } catch (cause) {
      if (current === generation.current)
        setLoadError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      pendingLoads.current -= 1
    }
  }, [dispatch.id, dispatch.workspaceId])
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden' && pendingLoads.current === 0) void load()
    }, 2000)
    return () => {
      generation.current += 1
      window.clearInterval(timer)
    }
  }, [load])
  const latest = view?.runs[0]
  const act = async (action: 'run' | 'accept' | 'cancel') => {
    if (!view || busy) return
    setBusy(true)
    setActionError(null)
    generation.current += 1
    try {
      if (action === 'run' && view.headSha) {
        await startDispatchVerification(dispatch.workspaceId, dispatch.id, {
          command: command.trim(),
          headSha: view.headSha,
          reportRevision: view.reportRevision,
        })
      } else if (latest) {
        await updateDispatchVerification(
          dispatch.workspaceId,
          dispatch.id,
          latest.id,
          action === 'accept' ? 'accept' : 'cancel'
        )
        onChanged()
      }
      await load()
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="app-overlay fixed inset-0 z-[60]" />
        <div className="pointer-events-none fixed inset-0 z-[70] grid place-items-center p-4">
          <Dialog.Content className="dispatch-verification-dialog elev-2">
            <header className="dispatch-diff-header">
              <div>
                <Dialog.Title className="text-lg font-semibold text-pri">
                  {t('verification.title')}
                </Dialog.Title>
                <Dialog.Description className="dispatch-report-note">
                  {t('verification.description')}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="activity-center-icon-button"
                  aria-label={t('common.close')}
                >
                  <X size={16} aria-hidden />
                </button>
              </Dialog.Close>
            </header>
            {view?.isolated ? (
              <nav className="delivery-step-navigation" aria-label={t('verification.sections')}>
                {(['verification', 'integration', 'publication', 'branch'] as const).map(
                  (value) => (
                    <button
                      key={value}
                      type="button"
                      className="icon-btn"
                      aria-pressed={panel === value}
                      onClick={() => setPanel(value)}
                    >
                      {t(`verification.section.${value}`)}
                    </button>
                  )
                )}
              </nav>
            ) : null}
            <div className="dispatch-verification-body scroll-y">
              <p className="dispatch-verification-task">{dispatch.text}</p>
              {error ? (
                <p role="alert" className="dispatch-report-error">
                  {error}
                </p>
              ) : null}
              {!view ? (
                <p>{t('delivery.loading')}</p>
              ) : (
                <>
                  {!view.isolated || panel === 'verification' ? (
                    <>
                      <div className="dispatch-verification-version">
                        <span>
                          {t('verification.version')}{' '}
                          <code title={view.headSha ?? ''}>
                            {view.headSha?.slice(0, 12) ?? '—'}
                          </code>
                        </span>
                        <button
                          type="button"
                          className="activity-center-icon-button"
                          onClick={() => {
                            setActionError(null)
                            void load()
                          }}
                          aria-label={t('activity.refresh')}
                        >
                          <RefreshCw size={14} aria-hidden />
                        </button>
                      </div>
                      {!view.headSha || view.unavailableReason ? (
                        <p className="dispatch-report-note">
                          {view.unavailableReason ?? t('verification.gitRequired')}
                        </p>
                      ) : null}
                      {view.isDirty ? (
                        <p className="dispatch-report-note">{t('verification.dirty')}</p>
                      ) : null}
                      {dispatch.reportOutcome && dispatch.reportOutcome !== 'success' ? (
                        <p className="dispatch-report-note">{t('verification.reportRequired')}</p>
                      ) : !view.canRun &&
                        !!view.headSha &&
                        !view.isDirty &&
                        latest?.state !== 'running' ? (
                        <p className="dispatch-report-note">{t('verification.workspaceBusy')}</p>
                      ) : null}
                      <label htmlFor={commandId}>{t('verification.command')}</label>
                      <textarea
                        id={commandId}
                        value={command}
                        onChange={(event) => setCommand(event.target.value)}
                        maxLength={2000}
                        rows={2}
                        placeholder="pnpm install --frozen-lockfile && pnpm test"
                        disabled={busy || latest?.state === 'running'}
                      />
                      <p className="dispatch-report-note">{t('verification.commandHint')}</p>
                      <button
                        type="button"
                        className="icon-btn icon-btn--primary"
                        disabled={busy || !!error || !view.canRun || !command.trim()}
                        onClick={() => void act('run')}
                      >
                        <Play size={14} aria-hidden />
                        {t('verification.run')}
                      </button>
                      {latest ? (
                        <section
                          className="dispatch-verification-result"
                          aria-label={t('verification.latest')}
                        >
                          <div className="dispatch-verification-version">
                            <strong>{t(`verification.state.${latest.state}`)}</strong>
                            <code>{latest.headSha.slice(0, 12)}</code>
                          </div>
                          <p className="dispatch-report-note">
                            {new Date(latest.startedAt).toLocaleString()} ·{' '}
                            {t('verification.exitCode')} {latest.exitCode ?? '—'}
                          </p>
                          <code className="dispatch-verification-command">{latest.command}</code>
                          {view.staleReason ? (
                            <p role="status">{t(`verification.stale.${view.staleReason}`)}</p>
                          ) : null}
                          {latest.error ? (
                            <p className="dispatch-report-error">{latest.error}</p>
                          ) : null}
                          <pre
                            className="dispatch-verification-output"
                            role="log"
                            aria-live="off"
                            aria-label={t('verification.output')}
                          >
                            {latest.output || t('verification.noOutput')}
                          </pre>
                          {latest.outputTruncated ? (
                            <p className="dispatch-report-note">{t('verification.truncated')}</p>
                          ) : null}
                          {latest.state === 'running' ? (
                            <button
                              type="button"
                              className="icon-btn icon-btn--secondary"
                              disabled={busy}
                              onClick={() => void act('cancel')}
                            >
                              <Square size={13} aria-hidden />
                              {t('verification.cancel')}
                            </button>
                          ) : null}
                          {view.accepted ? (
                            <p role="status" className="dispatch-verification-accepted">
                              <Check size={14} aria-hidden />
                              {t('verification.accepted')}
                            </p>
                          ) : view.canAccept ? (
                            <button
                              type="button"
                              className="icon-btn icon-btn--primary"
                              disabled={busy || !!error}
                              onClick={() => void act('accept')}
                            >
                              <Check size={14} aria-hidden />
                              {t('verification.accept')}
                            </button>
                          ) : null}
                        </section>
                      ) : (
                        <p className="dispatch-report-note">{t('verification.empty')}</p>
                      )}
                      {view.runs.length > 1 ? (
                        <details className="dispatch-verification-history">
                          <summary>{t('verification.history')}</summary>
                          {view.runs.slice(1).map((run) => (
                            <details key={run.id}>
                              <summary>
                                {new Date(run.startedAt).toLocaleString()} ·{' '}
                                {t(`verification.state.${run.state}`)} ·{' '}
                                <code>{run.headSha.slice(0, 12)}</code>
                              </summary>
                              <code className="dispatch-verification-command">{run.command}</code>
                              <pre className="dispatch-verification-output">{run.output}</pre>
                            </details>
                          ))}
                        </details>
                      ) : null}
                    </>
                  ) : null}
                  {view.isolated ? (
                    <div key={`${view.headSha}:${latest?.id}:${view.accepted}:${view.isDirty}`}>
                      {panel === 'integration' ? (
                        <DispatchIntegrationPanel
                          workspaceId={dispatch.workspaceId}
                          dispatchId={dispatch.id}
                          onChanged={onChanged}
                        />
                      ) : null}
                      {panel === 'publication' ? (
                        <DispatchPullRequestPanel dispatch={dispatch} onChanged={onChanged} />
                      ) : null}
                      {panel === 'branch' ? (
                        <WorkerBranchPanel
                          workspaceId={dispatch.workspaceId}
                          workerId={dispatch.toAgentId}
                          onChanged={() => {
                            void load()
                            onChanged()
                          }}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
