import { useEffect, useState } from 'react'
import type { DispatchTimeouts } from '../../../src/shared/message-delivery.js'
import { deliveryRequest, readTimeouts } from './message-delivery-api.js'

export const DispatchTimeoutSettings = ({
  workspaceId,
  zh,
  dispatchId,
  initial,
}: {
  workspaceId: string
  zh: boolean
  dispatchId?: string
  initial?: DispatchTimeouts
}) => {
  const [values, setValues] = useState<DispatchTimeouts | null>(initial ?? null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false)
  useEffect(() => {
    if (dispatchId) return
    let disposed = false
    void readTimeouts(workspaceId).then(
      (value) => {
        if (!disposed) setValues(value)
      },
      (cause) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause))
      }
    )
    return () => {
      disposed = true
    }
  }, [workspaceId, dispatchId])
  const labels: Record<keyof DispatchTimeouts, string> = {
    delivery_ms: zh ? '投递确认等待（秒）' : 'Receipt wait (seconds)',
    execution_ms: zh ? '执行时长提醒（秒）' : 'Execution reminder (seconds)',
    inactivity_ms: zh ? '无进展提醒（秒）' : 'Inactivity reminder (seconds)',
    cancellation_ms: zh ? '取消确认提醒（秒）' : 'Cancellation reminder (seconds)',
  }
  const save = async () => {
    if (!values) return
    setBusy(true)
    setError('')
    setSaved(false)
    try {
      await deliveryRequest(
        `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/${dispatchId ? `dispatches/${encodeURIComponent(dispatchId)}/timeouts` : 'dispatch-timeouts'}`,
        'PUT',
        values
      )
      setSaved(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <details className="text-sm">
      <summary className="cursor-pointer font-medium text-pri">
        {dispatchId
          ? zh
            ? '本任务提醒设置'
            : 'Task reminder settings'
          : zh
            ? '新任务默认提醒设置'
            : 'Defaults for new tasks'}
      </summary>
      <p className="my-3 text-sec">
        {zh
          ? '这些设置只影响提醒与投递等待，不会自动终止任务。空白的无进展时长表示关闭此类提醒。'
          : 'These settings control reminders and delivery waits, never automatic termination. Leave inactivity blank to disable that reminder.'}
      </p>
      {values ? (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
          className="space-y-3"
        >
          <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
            {(Object.keys(labels) as Array<keyof DispatchTimeouts>).map((key) => (
              <label key={key} className="block text-sec">
                {labels[key]}
                <input
                  className="input mt-1 w-full text-base"
                  type="number"
                  min={key === 'delivery_ms' ? 0.05 : 1}
                  max={key === 'delivery_ms' ? 120 : 604800}
                  step={key === 'delivery_ms' ? 0.05 : 1}
                  required={key !== 'inactivity_ms'}
                  value={values[key] === null ? '' : (values[key] ?? 0) / 1000}
                  onChange={(event) => {
                    setValues({
                      ...values,
                      [key]:
                        event.target.value === '' && key === 'inactivity_ms'
                          ? null
                          : Number(event.target.value) * 1000,
                    })
                    setSaved(false)
                  }}
                />
              </label>
            ))}
          </fieldset>
          <button type="submit" disabled={busy} className="icon-btn">
            {busy ? (zh ? '保存中…' : 'Saving…') : zh ? '保存提醒设置' : 'Save reminders'}
          </button>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-danger break-words">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="mt-2 text-sec">
          {zh ? '设置已保存。' : 'Settings saved.'}
        </p>
      ) : null}
    </details>
  )
}
