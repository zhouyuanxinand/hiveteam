import { useState } from 'react'
import type { DispatchHealth } from '../../../src/shared/message-delivery.js'
import { deliveryRequest } from './message-delivery-api.js'

export const CancellationReview = ({
  health,
  zh,
  onChanged,
}: {
  health: DispatchHealth
  zh: boolean
  onChanged: () => Promise<void>
}) => {
  const [reason, setReason] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  if (health.cancellation_requested_at === null) return null
  if (health.cancellation_confirmed_at !== null)
    return (
      <p className="mt-3 text-sec">
        {zh ? '取消停止已确认' : 'Cancellation stop acknowledged'} ·{' '}
        {health.cancellation_source === 'worker_ack'
          ? 'Worker'
          : zh
            ? '本机人工核对'
            : 'Local manual review'}
      </p>
    )
  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      await deliveryRequest(
        `/api/ui/workspaces/${encodeURIComponent(health.workspace_id)}/dispatches/${encodeURIComponent(health.dispatch_id)}/cancellation-confirmation`,
        'POST',
        { reason, acknowledge_stopped: confirmed }
      )
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <details className="mt-3 text-sm">
      <summary className="cursor-pointer text-pri">
        {zh ? '核对取消结果' : 'Review cancellation'}
      </summary>
      <p className="my-3 text-sec">
        {zh
          ? '取消提示不保证工具已停止。核对原终端与文件现场；停止整个 Worker 会同时影响它的其他任务。'
          : 'A cancellation message does not prove tools stopped. Inspect the original terminal and files. Stopping the whole Worker also affects its other tasks.'}
      </p>
      <label className="block text-sec">
        {zh ? '核对依据' : 'Evidence'}
        <textarea
          className="input mt-1 w-full text-base"
          rows={2}
          maxLength={2000}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <label className="my-3 flex items-start gap-2 text-sec">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        {zh ? '已确认这条任务停止执行。' : 'I verified that this task stopped executing.'}
      </label>
      <button
        type="button"
        className="icon-btn"
        disabled={busy || !confirmed || !reason.trim()}
        onClick={() => void submit()}
      >
        {zh ? '记录停止确认' : 'Record stop confirmation'}
      </button>
      {error ? (
        <p role="alert" className="mt-2 text-danger break-words">
          {error}
        </p>
      ) : null}
    </details>
  )
}
