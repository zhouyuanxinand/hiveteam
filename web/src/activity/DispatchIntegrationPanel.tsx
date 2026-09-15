import { GitMerge, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n.js'
import { type IntegrationPreview, requestDispatchIntegration } from './integration-api.js'

export const DispatchIntegrationPanel = ({
  workspaceId,
  dispatchId,
  onChanged,
}: {
  workspaceId: string
  dispatchId: string
  onChanged: () => void
}) => {
  const { t } = useI18n()
  const [preview, setPreview] = useState<IntegrationPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [integrating, setIntegrating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const load = useCallback(async () => {
    const current = ++generation.current
    setBusy(true)
    setError(null)
    try {
      const next = await requestDispatchIntegration(workspaceId, dispatchId)
      if (current === generation.current) setPreview(next)
    } catch (cause) {
      if (current === generation.current)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (current === generation.current) setBusy(false)
    }
  }, [workspaceId, dispatchId])
  useEffect(() => {
    void load()
    return () => {
      generation.current += 1
    }
  }, [load])
  const integrate = async () => {
    if (!preview?.can_integrate || busy) return
    setBusy(true)
    setIntegrating(true)
    setError(null)
    try {
      setPreview(await requestDispatchIntegration(workspaceId, dispatchId, preview))
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
      setIntegrating(false)
    }
  }
  return (
    <section className="dispatch-integration" aria-label={t('integration.title')}>
      <div className="dispatch-verification-version">
        <h3 className="font-semibold">{t('integration.title')}</h3>
        <button
          type="button"
          className="activity-center-icon-button"
          disabled={busy}
          aria-label={t('integration.refresh')}
          onClick={() => void load()}
        >
          <RefreshCw size={14} aria-hidden />
        </button>
      </div>
      <p className="dispatch-report-note">{t('integration.hint')}</p>
      {error ? (
        <p role="alert" className="dispatch-report-error">
          {error}
        </p>
      ) : null}
      {!preview ? (
        <p>{t('delivery.loading')}</p>
      ) : preview.worktree ? (
        <>
          <dl className="dispatch-integration-paths">
            <dt>{t('integration.source')}</dt>
            <dd>
              <code>{preview.worktree.branch}</code> ·{' '}
              <code>{preview.source_sha?.slice(0, 12)}</code>
            </dd>
            <dt>{t('integration.target')}</dt>
            <dd>
              <code>{preview.worktree.target_branch}</code> ·{' '}
              <code>{preview.target_sha?.slice(0, 12)}</code>
            </dd>
            <dt>{t('integration.directory')}</dt>
            <dd>
              <code>{preview.worktree.workspace_path}</code>
            </dd>
          </dl>
          {preview.integrated_at ? (
            <p role="status" className="dispatch-verification-accepted">
              <GitMerge size={14} aria-hidden />
              {t('integration.integrated')} · {new Date(preview.integrated_at).toLocaleString()}
            </p>
          ) : (
            <>
              {preview.reason ? (
                <p role="status" className="dispatch-report-note">
                  {t(`integration.reason.${preview.reason}`)}
                </p>
              ) : null}
              <details className="dispatch-verification-history" open>
                <summary>{t('integration.diff')}</summary>
                <pre className="dispatch-verification-output">
                  {preview.patch || t('integration.noDiff')}
                </pre>
                {preview.truncated ? (
                  <p className="dispatch-report-note">{t('integration.truncated')}</p>
                ) : null}
              </details>
              <button
                type="button"
                className="icon-btn icon-btn--primary"
                disabled={busy || !!error || !preview.can_integrate}
                onClick={() => void integrate()}
              >
                <GitMerge size={14} aria-hidden />
                {integrating
                  ? t('integration.busy')
                  : t('integration.apply', { branch: preview.worktree.target_branch })}
              </button>
            </>
          )}
        </>
      ) : null}
    </section>
  )
}
