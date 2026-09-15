import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n.js'
import {
  getWorktreeResources,
  removeWorktreeResource,
  type WorktreeResources,
  type WorktreeResourceView,
} from './worktree-lifecycle-api.js'

export const WorktreeResourcesPanel = () => {
  const { t } = useI18n()
  const [offset, setOffset] = useState(0)
  const [view, setView] = useState<WorktreeResources | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [removed, setRemoved] = useState<string | null>(null)
  const generation = useRef(0)
  const load = useCallback(async () => {
    const current = ++generation.current
    setBusy(true)
    try {
      const result = await getWorktreeResources(offset)
      if (current !== generation.current) return
      setView(result)
      setError(null)
      if (offset && offset >= result.total)
        setOffset(Math.max(0, Math.ceil(result.total / 10) - 1) * 10)
    } catch (cause) {
      if (current === generation.current)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (current === generation.current) setBusy(false)
    }
  }, [offset])
  useEffect(() => {
    void load()
    return () => {
      generation.current += 1
    }
  }, [load])
  const remove = async (item: WorktreeResourceView) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await removeWorktreeResource(item)
      setRemoved(item.branch)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const reasons: Record<string, string> = {
    worker_attached: t('resources.reason.worker_attached'),
    agents_running: t('branch.reason.agents_running'),
    removed: t('resources.removed'),
    merge_in_progress: t('branch.reason.merge_in_progress'),
    uncommitted_changes: t('resources.reason.uncommitted_changes'),
    not_integrated: t('resources.reason.not_integrated'),
  }
  return (
    <section className="delivery-queue" aria-label={t('resources.title')}>
      <div className="dispatch-verification-version">
        <p className="dispatch-report-note">{t('resources.hint')}</p>
        <button
          type="button"
          className="activity-center-icon-button"
          disabled={busy}
          aria-label={t('resources.refresh')}
          onClick={() => void load()}
        >
          <RefreshCw size={15} aria-hidden />
        </button>
      </div>
      {error ? (
        <p role="alert" className="dispatch-report-error">
          {error}
        </p>
      ) : null}
      {removed ? (
        <p role="status">
          {t('resources.removed')} <code>{removed}</code>
        </p>
      ) : null}
      {view ? (
        <>
          {!view.items.length ? (
            <p className="activity-center-empty">{t('resources.empty')}</p>
          ) : (
            <ul className="delivery-queue-list">
              {view.items.map((item) => (
                <li key={item.id}>
                  <strong>{item.workspace_name}</strong>
                  <dl className="dispatch-integration-paths">
                    <dt>{t('integration.directory')}</dt>
                    <dd>
                      <code>{item.checkout_path}</code>
                    </dd>
                    <dt>{t('integration.source')}</dt>
                    <dd>
                      <code>{item.branch}</code> · {item.head_sha?.slice(0, 12)}
                    </dd>
                    <dt>{t('integration.target')}</dt>
                    <dd>
                      <code>{item.target_branch}</code> · {item.target_sha?.slice(0, 12)}
                    </dd>
                  </dl>
                  <p className="dispatch-report-note">
                    {item.reason ? (reasons[item.reason] ?? item.reason) : t('resources.ready')}
                  </p>
                  {item.error ? <p className="dispatch-report-error">{item.error}</p> : null}
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={busy || !item.can_remove}
                    onClick={() => void remove(item)}
                  >
                    {t('resources.remove')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="delivery-queue-pagination">
            <button
              type="button"
              className="icon-btn"
              disabled={busy || !offset}
              onClick={() => setOffset(Math.max(0, offset - 10))}
            >
              {t('queue.previous')}
            </button>
            <span>
              {view.total
                ? `${offset + 1}–${Math.min(offset + 10, view.total)} / ${view.total}`
                : '0 / 0'}
            </span>
            <button
              type="button"
              className="icon-btn"
              disabled={busy || offset + 10 >= view.total}
              onClick={() => setOffset(offset + 10)}
            >
              {t('queue.next')}
            </button>
          </div>
        </>
      ) : !error ? (
        <p>{t('delivery.loading')}</p>
      ) : null}
    </section>
  )
}
