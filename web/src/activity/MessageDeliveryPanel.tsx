import { useCallback, useEffect, useState } from 'react'
import type { DeliveryOverview, MessageDelivery } from '../../../src/shared/message-delivery.js'
import { useI18n } from '../i18n.js'
import { isRemoteMode } from '../remote/remote-permissions-api.js'
import { CancellationReview } from './CancellationReview.js'
import { DispatchTimeoutSettings } from './DispatchTimeoutSettings.js'
import { MessageDeliveryActions } from './MessageDeliveryActions.js'
import { healthReason, readDeliveries } from './message-delivery-api.js'

const stateLabel = (record: MessageDelivery, zh: boolean) =>
  ({
    pending: zh ? '等待投递' : 'Waiting for delivery',
    attempting: zh ? '正在投递' : 'Delivering',
    unknown: zh ? '接收未确认' : 'Receipt unconfirmed',
    manual: zh ? '需要人工处理' : 'Needs manual review',
    confirmed: zh ? '已确认接收' : 'Receipt confirmed',
    resolved: zh ? '已处理' : 'Handled',
  })[record.state]
export const MessageDeliveryPanel = ({ workspaceId }: { workspaceId: string }) => {
  const { language } = useI18n(),
    zh = language === 'zh'
  const [data, setData] = useState<DeliveryOverview | null>(null),
    [error, setError] = useState(''),
    [all, setAll] = useState(false),
    [page, setPage] = useState(0)
  const load = useCallback(async () => {
    setData(await readDeliveries(workspaceId))
    setError('')
  }, [workspaceId])
  useEffect(() => {
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined
    setData(null)
    setPage(0)
    const refresh = async () => {
      try {
        const result = await readDeliveries(workspaceId)
        if (!disposed) {
          setData(result)
          setError('')
        }
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!disposed) timer = setTimeout(() => void refresh(), 2000)
      }
    }
    void refresh()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [workspaceId])
  const items = (data?.deliveries ?? []).filter(
    (entry) =>
      all ||
      (entry.state !== 'confirmed' && entry.state !== 'resolved') ||
      data?.health.some(
        (health) => health.dispatch_id === entry.dispatch_id && health.reasons.length
      )
  )
  const currentPage = Math.min(page, Math.max(0, Math.ceil(items.length / 25) - 1))
  const visible = items.slice(currentPage * 25, (currentPage + 1) * 25)
  return (
    <section
      className="space-y-5 p-4 text-sm"
      aria-label={zh ? '任务投递与健康' : 'Task delivery and health'}
    >
      <div>
        <h2 className="text-base font-semibold text-pri">
          {zh ? '任务投递与健康' : 'Task delivery and health'}
        </h2>
        <p className="mt-2 text-sec">
          {zh
            ? '提醒不会自动杀进程或宣告任务失败。接收回执、任务汇报和 Git 验证分别记录。'
            : 'Reminders never automatically kill a process or fail a task. Receipt, report and Git verification are separate facts.'}
        </p>
        {data ? (
          <p className="mt-2 text-sec">
            {zh ? '最长待处理时间' : 'Oldest pending delivery'}:{' '}
            {Math.round(data.oldest_pending_ms / 1000)} {zh ? '秒' : 's'}
          </p>
        ) : null}
      </div>
      {!isRemoteMode() ? (
        <DispatchTimeoutSettings workspaceId={workspaceId} zh={zh} />
      ) : (
        <p className="text-sec">
          {zh
            ? '远程可查看；投递处理与超时设置需在本机操作。'
            : 'Remote view only. Delivery decisions and timeout settings require the local computer.'}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={all}
            onChange={(event) => {
              setAll(event.target.checked)
              setPage(0)
            }}
          />
          {zh ? '包含已处理记录' : 'Include handled records'}
        </label>
        <button
          className="icon-btn"
          type="button"
          onClick={() =>
            void load().catch((cause) =>
              setError(cause instanceof Error ? cause.message : String(cause))
            )
          }
        >
          {zh ? '刷新' : 'Refresh'}
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-danger break-words">
          {error}
        </p>
      ) : null}
      {!data && !error ? (
        <p role="status" className="text-sec">
          {zh ? '正在读取任务状态…' : 'Loading task status…'}
        </p>
      ) : null}
      {data && !items.length ? (
        <p className="text-sec">
          {zh ? '目前没有需要关注的投递。' : 'No deliveries need attention.'}
        </p>
      ) : null}
      <ul className="space-y-5">
        {visible.map((record) => {
          const health = data?.health.find((item) => item.dispatch_id === record.dispatch_id)
          return (
            <li key={record.id} className="border-b pb-5" style={{ borderColor: 'var(--border)' }}>
              <div className="flex flex-wrap justify-between gap-2">
                <h3 className="font-medium text-pri break-words">
                  {record.recipient_name} ·{' '}
                  {record.kind === 'report'
                    ? zh
                      ? '汇报'
                      : 'Report'
                    : record.kind === 'cancel'
                      ? zh
                        ? '取消提示'
                        : 'Cancellation'
                      : zh
                        ? '派单'
                        : 'Dispatch'}
                </h3>
                <span className="text-sec">{stateLabel(record, zh)}</span>
              </div>
              <p className="mt-2 break-words text-pri">{record.task_text}</p>
              <p className="mt-2 text-sec">
                {zh ? '尝试次数' : 'Attempts'}: {record.attempt} ·{' '}
                {record.evidence === 'native_receipt'
                  ? zh
                    ? '原生日志回执'
                    : 'Native journal receipt'
                  : record.evidence === 'worker_ack'
                    ? zh
                      ? 'Worker 协议确认'
                      : 'Worker acknowledgement'
                    : record.evidence === 'pty_write'
                      ? zh
                        ? '仅确认终端提交'
                        : 'Terminal submission only'
                      : record.evidence === 'manual'
                        ? zh
                          ? '人工核对'
                          : 'Manually reviewed'
                        : zh
                          ? '无接收证据'
                          : 'No receipt evidence'}
              </p>
              {record.reason ? <p className="mt-2 break-words text-sec">{record.reason}</p> : null}
              {health?.started_at !== null && health?.started_at !== undefined ? (
                <p className="mt-2 text-sec">
                  {zh ? '执行计时起点' : 'Execution clock'}:{' '}
                  {health.start_source === 'submission_estimate'
                    ? zh
                      ? '按提交时间估算'
                      : 'Estimated from submission'
                    : zh
                      ? '按接收证据'
                      : 'From receipt evidence'}{' '}
                  · {new Date(health.started_at).toLocaleTimeString(language)}
                </p>
              ) : null}
              {health?.waiting_reason ? (
                <p className="mt-2 text-sec">{healthReason(health.waiting_reason, zh)}</p>
              ) : null}
              {health?.reasons.map((reason) => (
                <p key={reason} role="status" className="mt-2 text-pri">
                  {healthReason(reason, zh)}
                </p>
              ))}
              {!isRemoteMode() ? (
                <MessageDeliveryActions record={record} zh={zh} onChanged={load} />
              ) : null}
              {!isRemoteMode() && health && record.kind === 'dispatch' ? (
                <div className="mt-3">
                  <DispatchTimeoutSettings
                    workspaceId={workspaceId}
                    dispatchId={record.dispatch_id}
                    initial={health.timeouts}
                    zh={zh}
                  />
                  <CancellationReview health={health} zh={zh} onChanged={load} />
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
      {items.length > 25 ? (
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className="icon-btn"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            {zh ? '上一页' : 'Previous'}
          </button>
          <span>
            {currentPage + 1} / {Math.ceil(items.length / 25)}
          </span>
          <button
            type="button"
            className="icon-btn"
            disabled={(currentPage + 1) * 25 >= items.length}
            onClick={() => setPage(currentPage + 1)}
          >
            {zh ? '下一页' : 'Next'}
          </button>
        </div>
      ) : null}
    </section>
  )
}
