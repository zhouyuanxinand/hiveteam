import { ExternalLink, GitPullRequest, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { DispatchSummary } from '../api.js'
import { useI18n } from '../i18n.js'
import { type PullRequestView, requestPullRequest } from './pull-request-api.js'

export const DispatchPullRequestPanel = ({
  dispatch,
  onChanged,
}: {
  dispatch: DispatchSummary
  onChanged: () => void
}) => {
  const { t } = useI18n()
  const fieldId = useId()
  const [view, setView] = useState<PullRequestView | null>(null)
  const [title, setTitle] = useState(dispatch.text.split('\n')[0]?.slice(0, 256) ?? '')
  const [body, setBody] = useState(dispatch.reportText ?? '')
  const [busy, setBusy] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const active = useRef(false)
  const generation = useRef(0)
  const changed = useRef(onChanged)
  changed.current = onChanged
  const load = useCallback(
    async (action?: 'refresh' | { preview: PullRequestView; title: string; body: string }) => {
      if (active.current) return
      active.current = true
      const current = generation.current
      setBusy(true)
      setPublishing(!!action && action !== 'refresh')
      setError(null)
      try {
        const result = await requestPullRequest(dispatch.workspaceId, dispatch.id, action)
        if (current === generation.current) setView(result)
        if (action) changed.current()
      } catch (cause) {
        if (current === generation.current)
          setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (current === generation.current) {
          active.current = false
          setBusy(false)
          setPublishing(false)
        }
      }
    },
    [dispatch.workspaceId, dispatch.id]
  )
  useEffect(() => {
    generation.current += 1
    active.current = false
    void load()
    return () => {
      generation.current += 1
    }
  }, [load])
  const number = view?.publication?.number
  useEffect(() => {
    if (!number) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load('refresh')
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [load, number])
  const publication = view?.publication
  const snapshot = publication?.snapshot
  const stale =
    snapshot &&
    (snapshot.head_sha !== view?.head_sha || publication?.verification_id !== view?.verification_id)
  return (
    <section className="dispatch-integration dispatch-pull-request" aria-label={t('pr.title')}>
      <div className="dispatch-verification-version">
        <h3 className="font-semibold">{t('pr.title')}</h3>
        <button
          type="button"
          className="activity-center-icon-button"
          disabled={busy}
          aria-label={t('pr.refresh')}
          onClick={() => void load(number ? 'refresh' : undefined)}
        >
          <RefreshCw size={14} aria-hidden />
        </button>
      </div>
      <p className="dispatch-report-note">{t('pr.hint')}</p>
      {error || publication?.error ? (
        <p role="alert" className="dispatch-report-error">
          {error ?? publication?.error}
        </p>
      ) : null}
      {!view ? (
        !error ? (
          <p>{t('delivery.loading')}</p>
        ) : null
      ) : (
        <>
          <dl className="dispatch-integration-paths">
            <dt>{t('pr.repository')}</dt>
            <dd>{view.repository ?? '—'}</dd>
            <dt>{t('integration.source')}</dt>
            <dd>
              <code>{view.branch}</code> ·{' '}
              <code title={view.head_sha ?? ''}>{view.head_sha?.slice(0, 12)}</code>
            </dd>
            <dt>{t('integration.target')}</dt>
            <dd>
              <code>{view.base_branch}</code>
            </dd>
          </dl>
          {!snapshot && publication?.number ? (
            <div>
              <a
                className="activity-center-diff-button"
                href={`https://github.com/${publication.repository}/pull/${publication.number}`}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={14} aria-hidden />#{publication.number} ·{' '}
                {t('pr.awaitingEvidence')}
              </a>
            </div>
          ) : null}
          {snapshot ? (
            <>
              <a
                className="activity-center-diff-button"
                href={snapshot.url}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={14} aria-hidden />#{snapshot.number} · {snapshot.title}
              </a>
              <p className="dispatch-report-note">
                {t(`pr.state.${snapshot.state}`)}
                {snapshot.draft && snapshot.state === 'open' ? ` · ${t('pr.draft')}` : ''} ·{' '}
                {t('pr.checkedAt')} {new Date(snapshot.checked_at).toLocaleString()}
              </p>
              {stale ? (
                <p role="status" className="dispatch-report-error">
                  {t('pr.stale')}
                </p>
              ) : null}
              <details
                className="dispatch-verification-history"
                open={snapshot.ci_state === 'failed'}
              >
                <summary>
                  {t('pr.ci')} · {t(`pr.ci.${snapshot.ci_state}`)}
                </summary>
                <p className="dispatch-report-note">
                  {t('pr.ciHint')} <code>{snapshot.head_sha.slice(0, 12)}</code>
                </p>
                <ul className="delivery-check-list">
                  {snapshot.checks.map((check) => (
                    <li key={check.id} data-state={check.state}>
                      {check.url ? (
                        <a href={check.url} target="_blank" rel="noreferrer">
                          {check.name}
                        </a>
                      ) : (
                        <span>{check.name}</span>
                      )}
                      <span>{t(`pr.ci.${check.state}`)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            </>
          ) : null}
          {view.reason && view.reason !== 'published' ? (
            <p role="status" className="dispatch-report-note">
              {t(`pr.reason.${view.reason}`)}
            </p>
          ) : null}
          {view.can_publish ? (
            <form
              className="delivery-publish-form"
              onSubmit={(event) => {
                event.preventDefault()
                if (!busy && title.trim()) void load({ preview: view, title, body })
              }}
            >
              {!number ? (
                <>
                  <label htmlFor={`${fieldId}-title`}>{t('pr.subject')}</label>
                  <input
                    id={`${fieldId}-title`}
                    value={title}
                    maxLength={256}
                    required
                    disabled={busy}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                  <label htmlFor={`${fieldId}-body`}>{t('pr.body')}</label>
                  <textarea
                    id={`${fieldId}-body`}
                    value={body}
                    rows={3}
                    maxLength={60_000}
                    disabled={busy}
                    onChange={(event) => setBody(event.target.value)}
                  />
                </>
              ) : null}
              <p className="dispatch-report-note">{t('pr.publishHint')}</p>
              <button
                className="icon-btn icon-btn--primary"
                type="submit"
                disabled={busy || !!error || !title.trim()}
              >
                <GitPullRequest size={14} aria-hidden />
                {t(publishing ? 'pr.publishing' : number ? 'pr.update' : 'pr.publish')}
              </button>
            </form>
          ) : null}
        </>
      )}
    </section>
  )
}
