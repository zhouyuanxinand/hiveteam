import * as Dialog from '@radix-ui/react-dialog'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n.js'
import { deliveryRequest } from './message-delivery-api.js'

type StopImpact = { dispatches: Array<{ dispatch_id: string; task_text: string }> }

/** Task cancellation and stopping the shared process have different scopes. */
export const useRunStopConfirmation = () => {
  const { language } = useI18n()
  const zh = language === 'zh'
  const [impact, setImpact] = useState<StopImpact | null>(null)
  const pending = useRef<((confirmed: boolean) => void) | null>(null)
  useEffect(
    () => () => {
      pending.current?.(false)
    },
    []
  )
  const finish = (confirmed: boolean) => {
    pending.current?.(confirmed)
    pending.current = null
    setImpact(null)
  }
  const confirmStop = useCallback(async (runId: string) => {
    const next = await deliveryRequest<StopImpact>(
      `/api/runtime/runs/${encodeURIComponent(runId)}/stop-impact`
    )
    if (!next.dispatches.length) return true
    pending.current?.(false)
    setImpact(next)
    return new Promise<boolean>((resolve) => {
      pending.current = resolve
    })
  }, [])
  const stopConfirmation = (
    <Dialog.Root
      open={impact !== null}
      onOpenChange={(open) => {
        if (!open) finish(false)
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="app-overlay fixed inset-0 z-[80]" />
        <div className="pointer-events-none fixed inset-0 z-[81] grid place-items-center p-4">
          <Dialog.Content
            className="pointer-events-auto max-h-[85vh] w-[480px] max-w-full overflow-y-auto rounded-lg border p-5"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
          >
            <Dialog.Title className="text-lg font-semibold text-pri">
              {zh ? '停止整个 Worker？' : 'Stop the whole worker?'}
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-sec">
              {zh
                ? `停止进程将中断以下 ${impact?.dispatches.length ?? 0} 个未完成任务。任务记录会保留，需要重新启动 Worker 才能继续。`
                : `Stopping this process interrupts ${impact?.dispatches.length ?? 0} open tasks. Their records are retained; restart the worker to continue.`}
            </Dialog.Description>
            <ul className="my-4 max-h-64 space-y-3 overflow-y-auto text-sm text-pri">
              {impact?.dispatches.map((task) => (
                <li key={task.dispatch_id} className="break-words">
                  <p>{task.task_text}</p>
                  <p className="mt-1 font-mono text-xs text-ter">{task.dispatch_id}</p>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className="icon-btn" onClick={() => finish(false)}>
                {zh ? '继续运行' : 'Keep running'}
              </button>
              <button
                type="button"
                className="icon-btn icon-btn--danger-solid"
                onClick={() => finish(true)}
              >
                {zh ? '停止 Worker' : 'Stop worker'}
              </button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
  return { confirmStop, stopConfirmation }
}
