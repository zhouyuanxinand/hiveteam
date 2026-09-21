import { ChevronDown, FileDiff, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { TeamListItem } from '../../../src/shared/types.js'
import type {
  DeliveryFilter,
  WorkspaceDeliveryPage,
} from '../../../src/shared/workspace-delivery.js'
import type { DispatchSummary } from '../api.js'
import { useI18n } from '../i18n.js'
import { DispatchDiffDialog } from './DispatchDiffDialog.js'
import { DispatchReport } from './DispatchReport.js'
import { getWorkspaceDelivery } from './workspace-delivery-api.js'

export const WorkspaceDeliveryPanel = ({
  workspaceId,
  workers,
}: {
  workspaceId: string
  workers: TeamListItem[]
}) => {
  const { t, language } = useI18n()
  const zh = language === 'zh'
  const [page, setPage] = useState<WorkspaceDeliveryPage<DispatchSummary> | null>(null)
  const [filter, setFilter] = useState<DeliveryFilter>('all')
  const [query, setQuery] = useState('')
  const [queryDraft, setQueryDraft] = useState('')
  const [cursor, setCursor] = useState<string>()
  const [previous, setPrevious] = useState<Array<string | undefined>>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reviewId, setReviewId] = useState<string | null>(null)
  const generation = useRef(0)
  const inFlight = useRef<number | null>(null)
  const load = useCallback(async () => {
    if (inFlight.current !== null) return
    const current = ++generation.current
    inFlight.current = current
    try {
      const result = await getWorkspaceDelivery(workspaceId, { limit: 25, filter, query, cursor })
      if (current !== generation.current) return
      setPage(result)
      setError(null)
    } catch (cause) {
      if (current === generation.current)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (current === generation.current) setLoading(false)
      if (inFlight.current === current) inFlight.current = null
    }
  }, [workspaceId, filter, query, cursor])
  useEffect(() => {
    setPage(null)
    inFlight.current = null
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

  const dispatches = page?.items ?? []
  const review = dispatches.find((item) => item.id === reviewId) ?? null
  const resetPage = () => {
    setCursor(undefined)
    setPrevious([])
  }

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
                active: page?.summary.active ?? 0,
                waiting: page?.summary.waiting ?? 0,
                blocked: page?.summary.attention ?? 0,
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
          <form
            className="delivery-history-controls"
            onSubmit={(event) => {
              event.preventDefault()
              resetPage()
              setQuery(queryDraft)
            }}
          >
            <label>
              {zh ? '状态' : 'Status'}
              <select
                value={filter}
                onChange={(event) => {
                  resetPage()
                  setFilter(event.target.value as DeliveryFilter)
                }}
              >
                <option value="all">{zh ? '全部派单' : 'All dispatches'}</option>
                <option value="active">{zh ? '进行中' : 'In progress'}</option>
                <option value="waiting">{zh ? '待确认' : 'Awaiting acceptance'}</option>
                <option value="attention">{zh ? '需处理' : 'Needs attention'}</option>
              </select>
            </label>
            <label>
              {zh ? '查找任务' : 'Find tasks'}
              <input
                type="search"
                maxLength={200}
                value={queryDraft}
                onChange={(event) => setQueryDraft(event.target.value)}
              />
            </label>
            <button type="submit">{zh ? '查找' : 'Search'}</button>
          </form>
          {page ? (
            <p className="dispatch-report-note">
              {zh
                ? `工作区共 ${page.summary.total} 条；当前筛选 ${page.filtered_total} 条，最新在前。`
                : `${page.summary.total} in this workspace; ${page.filtered_total} in this history selection, newest first.`}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="dispatch-report-error">
              {error}
            </p>
          ) : null}
          {!loading && !error && dispatches.length === 0 ? <p>{t('delivery.empty')}</p> : null}
          {dispatches.map((dispatch) => (
            <details
              key={`${dispatch.id}-${dispatch.reportRevision}`}
              className="workspace-delivery-item"
            >
              <summary>
                <ChevronDown className="delivery-summary-chevron" size={13} aria-hidden />
                <span
                  className="workspace-delivery-item-status"
                  data-attention={dispatch.delivery_flags.attention}
                >
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
          <nav
            className="delivery-history-controls"
            aria-label={zh ? '派单历史分页' : 'Delivery history pages'}
          >
            <button
              type="button"
              disabled={loading || !previous.length}
              onClick={() => {
                setCursor(previous.at(-1))
                setPrevious(previous.slice(0, -1))
              }}
            >
              {zh ? '上一页' : 'Previous page'}
            </button>
            <button
              type="button"
              disabled={loading || !page?.next_cursor}
              onClick={() => {
                if (!page?.next_cursor) return
                setPrevious([...previous, cursor])
                setCursor(page.next_cursor)
              }}
            >
              {zh ? '更早的派单' : 'Older dispatches'}
            </button>
            {cursor ? (
              <button type="button" onClick={resetPage}>
                {zh ? '返回最新' : 'Back to latest'}
              </button>
            ) : null}
          </nav>
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
