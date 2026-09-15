import { ArrowRight, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { deliveryQueueStates } from '../../../src/shared/delivery-queue.js'
import type { WorkspaceSummary } from '../../../src/shared/types.js'
import { type DispatchSummary, listWorkspaces } from '../api.js'
import { useI18n } from '../i18n.js'
import { DispatchReport } from './DispatchReport.js'
import { DispatchVerificationDialog, type VerificationPanel } from './DispatchVerificationDialog.js'
import { type DeliveryQueue, getDeliveryQueue } from './delivery-queue-api.js'

export const DeliveryQueuePanel = ({
  onSelectWorkspace,
}: {
  onSelectWorkspace?: (id: string) => void
}) => {
  const { t } = useI18n()
  const filterId = useId()
  const [workspaceId, setWorkspaceId] = useState('')
  const [state, setState] = useState('')
  const [offset, setOffset] = useState(0)
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [queue, setQueue] = useState<DeliveryQueue | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<{
    dispatch: DispatchSummary
    panel: VerificationPanel
  } | null>(null)
  const generation = useRef(0)
  const active = useRef(false)
  const load = useCallback(async () => {
    if (active.current) return
    active.current = true
    const current = generation.current
    setBusy(true)
    try {
      const result = await getDeliveryQueue({ workspaceId, state, offset })
      if (current !== generation.current) return
      setQueue(result)
      setError(null)
      if (offset && offset >= result.total)
        setOffset(Math.max(0, Math.ceil(result.total / 25) - 1) * 25)
    } catch (cause) {
      if (current === generation.current)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (current === generation.current) {
        active.current = false
        setBusy(false)
      }
    }
  }, [workspaceId, state, offset])
  useEffect(() => {
    let mounted = true
    void listWorkspaces()
      .then((rows) => {
        if (mounted) setWorkspaces(rows)
      })
      .catch((cause: unknown) => {
        if (mounted) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      mounted = false
    }
  }, [])
  useEffect(() => {
    generation.current += 1
    active.current = false
    setQueue(null)
    void load()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, 10_000)
    return () => {
      generation.current += 1
      window.clearInterval(timer)
    }
  }, [load])
  return (
    <section className="delivery-queue" aria-label={t('queue.title')}>
      <p className="dispatch-report-note">{t('queue.hint')}</p>
      <div className="delivery-queue-filters">
        <label htmlFor={`${filterId}-workspace`}>
          {t('queue.workspace')}
          <select
            id={`${filterId}-workspace`}
            value={workspaceId}
            onChange={(event) => {
              setWorkspaceId(event.target.value)
              setOffset(0)
            }}
          >
            <option value="">{t('queue.allWorkspaces')}</option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={`${filterId}-state`}>
          {t('queue.state')}
          <select
            id={`${filterId}-state`}
            value={state}
            onChange={(event) => {
              setState(event.target.value)
              setOffset(0)
            }}
          >
            <option value="">{t('queue.allStates')}</option>
            {deliveryQueueStates.map((value) => (
              <option key={value} value={value}>
                {t(`queue.state.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="activity-center-icon-button"
          disabled={busy}
          aria-label={t('queue.refresh')}
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
      {queue ? (
        <>
          <p className="dispatch-report-note" role="status">
            {t('queue.count', { count: queue.total })}
          </p>
          {!queue.items.length ? (
            <p className="activity-center-empty">{t('queue.empty')}</p>
          ) : (
            <ol className="delivery-queue-list">
              {queue.items.map((item) => (
                <li key={item.dispatch.id}>
                  <div className="delivery-queue-row-heading">
                    <strong>{t(`queue.state.${item.state}`)}</strong>
                    <time dateTime={new Date(item.dispatch.createdAt).toISOString()}>
                      {new Date(item.dispatch.createdAt).toLocaleDateString()}
                    </time>
                  </div>
                  <p className="dispatch-report-note">
                    {item.workspace_name} · {item.worker_name}
                  </p>
                  <p className="delivery-queue-task">{item.dispatch.text}</p>
                  {item.checked_at ? (
                    <p className="dispatch-report-note">
                      {t('pr.checkedAt')} {new Date(item.checked_at).toLocaleString()}
                    </p>
                  ) : null}
                  {item.dispatch.lastError ? (
                    <p className="dispatch-report-error">{item.dispatch.lastError}</p>
                  ) : null}
                  <div className="delivery-queue-actions">
                    {item.dispatch.state === 'reported' &&
                    (!item.dispatch.reportOutcome || item.dispatch.reportOutcome === 'success') ? (
                      <button
                        type="button"
                        className="icon-btn icon-btn--primary"
                        onClick={() =>
                          setSelected({
                            dispatch: item.dispatch,
                            panel:
                              item.state === 'integrate'
                                ? 'integration'
                                : [
                                      'publish_failed',
                                      'ci_failed',
                                      'pull_request',
                                      'publishing',
                                    ].includes(item.state)
                                  ? 'publication'
                                  : 'verification',
                          })
                        }
                      >
                        {t('queue.review')}
                        <ArrowRight size={14} aria-hidden />
                      </button>
                    ) : null}
                    {onSelectWorkspace ? (
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => onSelectWorkspace(item.workspace_id)}
                      >
                        {t('queue.openWorkspace')}
                      </button>
                    ) : null}
                  </div>
                  {item.dispatch.state === 'reported' ? (
                    <details className="delivery-queue-report">
                      <summary>{t('queue.report')}</summary>
                      <DispatchReport dispatch={item.dispatch} onChanged={load} />
                    </details>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
          <div className="delivery-queue-pagination">
            <button
              type="button"
              className="icon-btn"
              disabled={busy || offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 25))}
            >
              {t('queue.previous')}
            </button>
            <span>
              {queue.total
                ? `${offset + 1}–${Math.min(offset + queue.limit, queue.total)} / ${queue.total}`
                : '0 / 0'}
            </span>
            <button
              type="button"
              className="icon-btn"
              disabled={busy || offset + queue.limit >= queue.total}
              onClick={() => setOffset(offset + 25)}
            >
              {t('queue.next')}
            </button>
          </div>
        </>
      ) : !error ? (
        <p>{t('delivery.loading')}</p>
      ) : null}
      {selected ? (
        <DispatchVerificationDialog
          key={selected.dispatch.id}
          dispatch={selected.dispatch}
          initialPanel={selected.panel}
          onClose={() => setSelected(null)}
          onChanged={load}
        />
      ) : null}
    </section>
  )
}
