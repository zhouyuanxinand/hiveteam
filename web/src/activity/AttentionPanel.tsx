import { RefreshCw } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import {
  ATTENTION_KINDS,
  type AttentionItem,
  type AttentionKind,
  type AttentionPage,
} from '../../../src/shared/activity-attention.js'
import type { DispatchSummary } from '../api.js'
import { useI18n } from '../i18n.js'
import { RemoteAccessButton } from '../remote/RemoteAccessButton.js'
import { readAttention, readAttentionDispatch } from './activity-attention-api.js'
import { DispatchReport } from './DispatchReport.js'
import './attention.css'

const labels = (zh: boolean): Record<AttentionKind, string> => ({
  question: zh ? '问题待答复' : 'Unanswered question',
  report_delivery: zh ? '汇报待送达' : 'Report delivery',
  stopped_worker: zh ? '成员已停止，任务排队中' : 'Stopped member with queued work',
  acceptance: zh ? '报告待验收' : 'Report awaiting acceptance',
  remote_connection: zh ? '远程连接需处理' : 'Remote connection',
})
const remoteReason = (state: string, zh: boolean) =>
  ({
    loggedOut: zh ? '远程访问已启用，请登录。' : 'Remote access is enabled. Sign in to connect.',
    reconnecting: zh ? '连接已断开，正在重连。' : 'Connection interrupted. Reconnecting.',
    revoked: zh ? '设备凭据已失效，请重新登录。' : 'Credentials revoked. Sign in again.',
    disabled: zh
      ? '远程访问已启用，中继尚未连接。'
      : 'Remote access is enabled; the relay is disconnected.',
  })[state]

export const AttentionPanel = ({
  workspaceId,
  onInspectAgent,
  onInspectDelivery,
}: {
  workspaceId: string
  onInspectAgent?: ((workspaceId: string, agentId: string) => void) | undefined
  onInspectDelivery: (deliveryId: string) => void
}) => {
  const { language } = useI18n(),
    zh = language === 'zh',
    names = labels(zh)
  const filterId = useId()
  const [filter, setFilter] = useState('all')
  const [cursors, setCursors] = useState<Array<string | null>>([null])
  const cursor = cursors.at(-1) ?? null
  const [refreshKey, setRefreshKey] = useState(0)
  const [page, setPage] = useState<AttentionPage | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Pick<AttentionItem, 'id' | 'dispatch_id'> | null>(null)
  const [report, setReport] = useState<DispatchSummary | null>(null)
  const [reportError, setReportError] = useState('')
  const refresh = () => {
    setCursors([null])
    setRefreshKey((value) => value + 1)
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: Manual refresh invalidates this read even when its scope is unchanged.
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    setPage(null)
    setError('')
    setLoading(true)
    const load = async () => {
      try {
        const result = await readAttention(workspaceId, filter, cursor, controller.signal)
        if (!controller.signal.aborted) {
          setPage(result)
          setError('')
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false)
          if (!cursor) timer = setTimeout(() => void load(), 5000)
        }
      }
    }
    void load()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [workspaceId, filter, cursor, refreshKey])
  // biome-ignore lint/correctness/useExhaustiveDependencies: Manual refresh invalidates this read even when its scope is unchanged.
  useEffect(() => {
    const controller = new AbortController()
    setReport(null)
    setReportError('')
    if (selected?.dispatch_id)
      void readAttentionDispatch(workspaceId, selected.dispatch_id, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) setReport(result)
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted)
            setReportError(cause instanceof Error ? cause.message : String(cause))
        })
    return () => controller.abort()
  }, [workspaceId, selected, refreshKey])
  const changePage = (next: Array<string | null>) => {
    setSelected(null)
    setCursors(next)
  }
  return (
    <section className="attention-panel" aria-label={zh ? '待处理事项' : 'Needs attention'}>
      <header>
        <h2>{zh ? '待处理事项' : 'Needs attention'}</h2>
        <p className="text-sec">
          {zh
            ? '查看需要答复、送达或验收的事项，打开对应位置继续处理。'
            : 'Find questions, deliveries and reports that need a decision, then open their workspace controls.'}
        </p>
      </header>
      <div className="attention-controls">
        <label htmlFor={filterId}>{zh ? '事项类型' : 'Item type'}</label>
        <select
          id={filterId}
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value)
            setSelected(null)
            setCursors([null])
          }}
        >
          <option value="all">
            {zh ? '全部' : 'All'}
            {page ? ` (${page.total})` : ''}
          </option>
          {ATTENTION_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {names[kind]}
              {page ? ` (${page.counts[kind]})` : ''}
            </option>
          ))}
        </select>
        <button type="button" className="icon-btn" onClick={refresh} disabled={loading}>
          <RefreshCw size={14} aria-hidden />
          {zh ? '刷新待处理事项' : 'Refresh attention'}
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-danger">
          {error} {zh ? '请刷新重试。' : 'Refresh to retry.'}
        </p>
      ) : null}
      {loading ? (
        <p role="status" className="text-sec">
          {zh ? '正在读取待处理事项…' : 'Loading needs attention…'}
        </p>
      ) : null}
      {page && !page.items.length ? (
        <p role="status" className="text-sec">
          {zh ? '当前筛选下没有待处理事项。' : 'No items need attention in this view.'}
        </p>
      ) : null}
      <ul className="attention-list">
        {page?.items.map((item) => (
          <li key={item.id}>
            <div className="attention-meta">
              <h3>{names[item.kind]}</h3>
              {item.since !== null ? (
                <time dateTime={new Date(item.since).toISOString()}>
                  {new Date(item.since).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}
                </time>
              ) : null}
            </div>
            {item.agent_name ? <p className="text-sec">{item.agent_name}</p> : null}
            {item.task_text ? <p className="attention-task">{item.task_text}</p> : null}
            {item.detail ? <p className="attention-detail text-sec">{item.detail}</p> : null}
            {item.kind === 'question' ? (
              <details>
                <summary>{zh ? '查看对话命令' : 'View conversation command'}</summary>
                <code>team messages --dispatch {item.dispatch_id}</code>
                <p className="text-sec">
                  {zh ? '问题编号' : 'Question ID'}: {item.message_id}
                </p>
              </details>
            ) : null}
            <div className="attention-item-actions">
              {(item.kind === 'question' || item.kind === 'stopped_worker') &&
              item.agent_id &&
              onInspectAgent ? (
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => onInspectAgent(item.workspace_id, item.agent_id as string)}
                >
                  {zh ? '打开成员终端' : 'Open member terminal'}
                </button>
              ) : null}
              {item.kind === 'report_delivery' && item.delivery_id ? (
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => onInspectDelivery(item.delivery_id as string)}
                >
                  {zh ? '查看投递回执' : 'Inspect delivery receipt'}
                </button>
              ) : null}
              {item.kind === 'acceptance' && item.dispatch_id ? (
                <button
                  type="button"
                  className="icon-btn"
                  aria-expanded={selected?.id === item.id}
                  onClick={() => {
                    setReport(null)
                    setReportError('')
                    setSelected((current) =>
                      current?.id === item.id
                        ? null
                        : { id: item.id, dispatch_id: item.dispatch_id }
                    )
                  }}
                >
                  {selected?.id === item.id
                    ? zh
                      ? '收起报告'
                      : 'Close report'
                    : zh
                      ? '查看并处理报告'
                      : 'Inspect report'}
                </button>
              ) : null}
              {item.kind === 'remote_connection' ? (
                <>
                  <p className="text-sec">{remoteReason(item.state, zh)}</p>
                  <RemoteAccessButton inlinePanel />
                </>
              ) : null}
            </div>
            {item.kind === 'acceptance' && selected?.id === item.id ? (
              <div className="attention-report">
                {reportError ? (
                  <p role="alert" className="text-danger">
                    {reportError} {zh ? '请刷新重试。' : 'Refresh to retry.'}
                  </p>
                ) : report?.id === selected?.dispatch_id ? (
                  <DispatchReport
                    dispatch={report}
                    onChanged={() => {
                      setSelected(null)
                      refresh()
                    }}
                  />
                ) : (
                  <p role="status">{zh ? '正在读取报告…' : 'Loading report…'}</p>
                )}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {cursors.length > 1 || page?.next_cursor ? (
        <nav className="attention-pagination" aria-label={zh ? '待处理分页' : 'Attention pages'}>
          <button
            type="button"
            className="icon-btn"
            disabled={loading || cursors.length === 1}
            onClick={() => changePage(cursors.slice(0, -1))}
          >
            {zh ? '上一页' : 'Previous'}
          </button>
          <span className="text-sec">
            {zh ? `第 ${cursors.length} 页` : `Page ${cursors.length}`}
          </span>
          <button
            type="button"
            className="icon-btn"
            disabled={loading || !page?.next_cursor}
            onClick={() => {
              if (page?.next_cursor) changePage([...cursors, page.next_cursor])
            }}
          >
            {zh ? '下一页' : 'Next'}
          </button>
        </nav>
      ) : null}
    </section>
  )
}
