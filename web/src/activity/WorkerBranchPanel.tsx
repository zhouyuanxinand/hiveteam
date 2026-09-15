import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n.js'
import { type BranchUpdateView, requestBranchUpdate } from './worktree-lifecycle-api.js'

export const WorkerBranchPanel = ({
  workspaceId,
  workerId,
  onChanged,
}: {
  workspaceId: string
  workerId: string
  onChanged: () => void
}) => {
  const { t } = useI18n()
  const [view, setView] = useState<BranchUpdateView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const load = useCallback(async () => {
    const current = ++generation.current
    setBusy(true)
    try {
      const value = await requestBranchUpdate(workspaceId, workerId)
      if (current === generation.current) {
        setView(value)
        setError(null)
      }
    } catch (cause) {
      if (current === generation.current)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (current === generation.current) setBusy(false)
    }
  }, [workspaceId, workerId])
  useEffect(() => {
    void load()
    return () => {
      generation.current += 1
    }
  }, [load])
  const act = async (action: 'update' | 'continue' | 'abort') => {
    if (!view || busy) return
    setBusy(true)
    setError(null)
    try {
      setView(await requestBranchUpdate(workspaceId, workerId, action, view))
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="dispatch-integration" aria-label={t('branch.title')}>
      <div className="dispatch-verification-version">
        <h3 className="font-semibold">{t('branch.title')}</h3>
        <button
          type="button"
          className="activity-center-icon-button"
          disabled={busy}
          aria-label={t('branch.refresh')}
          onClick={() => void load()}
        >
          <RefreshCw size={14} aria-hidden />
        </button>
      </div>
      <p className="dispatch-report-note">{t('branch.hint')}</p>
      {error || view?.update?.error ? (
        <p className="dispatch-report-error" role="alert">
          {error ?? view?.update?.error}
        </p>
      ) : null}
      {view ? (
        <>
          <dl className="dispatch-integration-paths">
            <dt>{t('integration.source')}</dt>
            <dd>
              <code>{view.branch}</code> · <code>{view.source_sha?.slice(0, 12)}</code>
            </dd>
            <dt>{t('integration.target')}</dt>
            <dd>
              <code>{view.target_branch}</code> ·{' '}
              <code>
                {(view.can_abort ? view.update?.target_sha : view.target_sha)?.slice(0, 12)}
              </code>
            </dd>
            <dt>{t('integration.directory')}</dt>
            <dd>
              <code>{view.workspace_path}</code>
            </dd>
          </dl>
          {view.reason ? (
            <p className="dispatch-report-note" role="status">
              {t(`branch.reason.${view.reason}`)}
            </p>
          ) : null}
          {view.update?.state === 'complete' ? (
            <p className="dispatch-report-note" role="status">
              {t('branch.updated')}
            </p>
          ) : null}
          {view.update?.state === 'aborted' ? (
            <p className="dispatch-report-note" role="status">
              {t('branch.aborted')}
            </p>
          ) : null}
          {view.conflicts.length ? (
            <ul className="dispatch-report-artifacts" aria-label={t('branch.conflicts')}>
              {view.conflicts.map((file) => (
                <li key={file}>
                  <code>{file}</code>
                </li>
              ))}
            </ul>
          ) : null}
          {view.can_abort ? (
            <>
              <p className="dispatch-report-note">{t('branch.resolveHint')}</p>
              <details className="dispatch-verification-history">
                <summary>{t('branch.resolutionDiff')}</summary>
                <pre className="dispatch-verification-output">
                  {view.patch || t('integration.noDiff')}
                </pre>
                {view.truncated ? <p>{t('integration.truncated')}</p> : null}
              </details>
            </>
          ) : null}
          <div className="delivery-queue-actions">
            {view.can_update ? (
              <button
                type="button"
                className="icon-btn"
                disabled={busy || !!error}
                onClick={() => void act('update')}
              >
                {t('branch.update', { branch: view.target_branch })}
              </button>
            ) : null}
            {view.can_abort ? (
              <>
                <button
                  type="button"
                  className="icon-btn icon-btn--primary"
                  disabled={busy || !!error || !view.can_continue}
                  onClick={() => void act('continue')}
                >
                  {t('branch.continue')}
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  disabled={busy || !!error}
                  onClick={() => void act('abort')}
                >
                  {t('branch.abort')}
                </button>
              </>
            ) : null}
          </div>
        </>
      ) : !error ? (
        <p>{t('delivery.loading')}</p>
      ) : null}
    </section>
  )
}
