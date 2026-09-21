import { useState } from 'react'
import type { MessageDelivery } from '../../../src/shared/message-delivery.js'
import { deliveryPath, deliveryRequest } from './message-delivery-api.js'

export const MessageDeliveryActions = ({
  record,
  zh,
  onChanged,
}: {
  record: MessageDelivery
  zh: boolean
  onChanged: () => Promise<void>
}) => {
  const [expanded, setExpanded] = useState(false),
    [reason, setReason] = useState(''),
    [safe, setSafe] = useState(false),
    [repeat, setRepeat] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const action = async (kind: 'recheck' | 'handled' | 'resend') => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await deliveryRequest<{ confirmed?: boolean }>(
        `${deliveryPath(record.workspace_id)}/${encodeURIComponent(record.id)}/resolve`,
        'POST',
        { action: kind, reason, composer_safe: safe, acknowledge_resend: repeat }
      )
      if (kind === 'recheck')
        setNotice(
          result.confirmed
            ? zh
              ? '已找到原生接收回执。'
              : 'Native receipt found.'
            : zh
              ? '尚未找到回执，未再次发送。'
              : 'No receipt found; nothing was resent.'
        )
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  if (record.state === 'confirmed' || record.state === 'resolved') return null
  return (
    <div className="mt-3 space-y-3 text-sm">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="icon-btn"
          disabled={busy || record.state === 'attempting'}
          onClick={() => void action('recheck')}
        >
          {zh ? '重新核对回执' : 'Recheck receipt'}
        </button>
        <button
          type="button"
          className="icon-btn"
          disabled={busy || record.state === 'attempting'}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {zh ? '人工处理' : 'Review manually'}
        </button>
      </div>
      {notice ? (
        <p role="status" className="text-sec">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-danger break-words">
          {error}
        </p>
      ) : null}
      {expanded ? (
        <fieldset disabled={busy} className="space-y-3">
          <legend className="font-medium text-pri">
            {zh ? '核对原终端后继续' : 'Continue after checking the original terminal'}
          </legend>
          <label className="block text-sec">
            {zh ? '处理理由' : 'Reason'}
            <textarea
              className="input mt-1 w-full text-base"
              value={reason}
              maxLength={2000}
              required
              rows={2}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <label className="flex items-start gap-2 text-sec">
            <input
              type="checkbox"
              checked={safe}
              onChange={(event) => setSafe(event.target.checked)}
            />
            {zh
              ? '已核对接收结果，输入框安全，可以继续该接收者的队列。'
              : 'I checked receipt and the composer is safe to continue this recipient’s queue.'}
          </label>
          <button
            type="button"
            className="icon-btn"
            disabled={!safe || !reason.trim()}
            onClick={() => void action('handled')}
          >
            {zh ? '确认已处理' : 'Mark handled'}
          </button>
          <p className="text-sec">
            {zh
              ? '重发可能重复执行文件修改或外部操作。确认已处理不代表任务完成，也不代表验证通过。'
              : 'Resending may repeat file edits or external actions. Marking handled does not complete or verify the task.'}
          </p>
          <label className="flex items-start gap-2 text-sec">
            <input
              type="checkbox"
              checked={repeat}
              onChange={(event) => setRepeat(event.target.checked)}
            />
            {zh
              ? '我明确选择再次发送，并接受重复执行风险。'
              : 'I explicitly choose to resend and accept the risk of repeated execution.'}
          </label>
          <button
            type="button"
            className="icon-btn icon-btn--danger"
            disabled={!safe || !repeat || !reason.trim()}
            onClick={() => void action('resend')}
          >
            {zh ? '按原标识重发' : 'Resend with original ID'}
          </button>
        </fieldset>
      ) : null}
    </div>
  )
}
