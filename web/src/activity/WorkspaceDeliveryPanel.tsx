import { ChevronDown, FileDiff, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { TeamListItem } from '../../../src/shared/types.js'
import { type DispatchSummary, listWorkspaceDispatches } from '../api.js'
import { useI18n } from '../i18n.js'
import { DispatchDiffDialog } from './DispatchDiffDialog.js'
import { DispatchReport } from './DispatchReport.js'

export const WorkspaceDeliveryPanel = ({
  workspaceId,
  workers,
}: {
  workspaceId: string
  workers: TeamListItem[]
}) => {
  const { t } = useI18n()
  const [dispatches, setDispatches] = useState<DispatchSummary[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reviewId, setReviewId] = useState<string | null>(null)
  const generation = useRef(0)
  const load = useCallback(async () => {
    const current = ++generation.current
    try {
      const result = await listWorkspaceDispatches(workspaceId, { limit: 100 })
      if (current !== generation.current) return
      setDispatches(result)
      setError(null)
    } catch (cause) {
      if (current === generation.current)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }, [workspaceId])
  useEffect(() => {
    setDispatches([])
    setLoading(true)
    setError(null)
    setReviewId(null)
    void load()
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void load()
    }, 4000)
    return () => {
      generation.current += 1
      window.clearInterval(timer)
    }
  }, [load])

  const blocked = (item: DispatchSummary) =>
    item.state === 'failed' ||
    (item.state === 'reported' && !!item.reportOutcome && item.reportOutcome !== 'success')
  const waiting = (item: DispatchSummary) =>
    item.state === 'reported' && !item.acceptedAt && !blocked(item)
  const active = dispatches.filter(
    (item) => item.state === 'queued' || item.state === 'submitted'
  ).length
  const review = dispatches.find((item) => item.id === reviewId) ?? null
  const ordered = [...dispatches].sort(
    (left, right) =>
      Number(blocked(right)) - Number(blocked(left)) ||
      Number(waiting(right)) - Number(waiting(left))
  )

  return (
    <section className="workspace-delivery" aria-label={t('delivery.title')}>
      <div className="workspace-delivery-bar">
        <button
          type="button"
          className="workspace-delivery-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <ChevronDown size={15} aria-hidden data-open={open} />
          <strong>{t('delivery.title')}</strong>
          {loading ? (
            <span>{t('delivery.loading')}</span>
          ) : error ? (
            <span>{t('delivery.loadFailed')}</span>
          ) : (
            <span>
              {t('delivery.summary', {
                active,
                waiting: dispatches.filter(waiting).length,
                blocked: dispatches.filter(blocked).length,
              })}
            </span>
          )}
        </button>
        <button
          type="button"
          className="activity-center-icon-button"
          aria-label={t('activity.refresh')}
          onClick={() => void load()}
        >
          <RefreshCw size={14} aria-hidden />
        </button>
      </div>
      {open ? (
        <div className="workspace-delivery-content">
          <p className="dispatch-report-note">{t('delivery.recent')}</p>
          {error ? (
            <p role="alert" className="dispatch-report-error">
              {error}
            </p>
          ) : null}
          {!loading && !error && dispatches.length === 0 ? <p>{t('delivery.empty')}</p> : null}
          {ordered.map((dispatch) => (
            <details
              key={`${dispatch.id}-${dispatch.reportRevision}`}
              className="workspace-delivery-item"
            >
              <summary>
                <ChevronDown className="delivery-summary-chevron" size={13} aria-hidden />
                <span className="workspace-delivery-item-status" data-attention={blocked(dispatch)}>
                  {dispatch.state === 'reported'
                    ? t(
                        dispatch.acceptedAt
                          ? 'delivery.accepted'
                          : `delivery.outcome.${dispatch.reportOutcome ?? 'unknown'}`
                      )
                    : t(`activity.state.${dispatch.state}`)}
                </span>
                <span className="workspace-delivery-task">{dispatch.text}</span>
                <span>
                  {workers.find((worker) => worker.id === dispatch.toAgentId)?.name ??
                    dispatch.toAgentId}
                </span>
              </summary>
              <p className="dispatch-report-body">{dispatch.text}</p>
              {dispatch.lastError ? (
                <p className="dispatch-report-error">{dispatch.lastError}</p>
              ) : null}
              {dispatch.baseHeadSha ? (
                <button
                  type="button"
                  className="activity-center-diff-button"
                  onClick={() => setReviewId(dispatch.id)}
                >
                  <FileDiff size={14} aria-hidden /> {t('activity.reviewChanges')}
                </button>
              ) : null}
              <DispatchReport
                key={`${dispatch.id}-${dispatch.reportRevision}`}
                dispatch={dispatch}
                onChanged={() => void load()}
              />
            </details>
          ))}
        </div>
      ) : null}
      {review ? (
        <DispatchDiffDialog
          dispatch={review}
          onClose={() => setReviewId(null)}
          onFeedbackSent={() => void load()}
          open
          targetLabel={
            workers.find((worker) => worker.id === review.toAgentId)?.name ?? review.toAgentId
          }
          workspaceId={workspaceId}
        />
      ) : null}
    </section>
  )
}
