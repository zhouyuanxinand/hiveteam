import * as Dialog from '@radix-ui/react-dialog'
import { Gauge, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ExecutionKind } from '../../../src/shared/resource-budget.js'
import type { ResourceStatus } from '../../../src/shared/resource-status.js'
import { useRunStopConfirmation } from '../activity/useRunStopConfirmation.js'
import { useI18n } from '../i18n.js'
import { isRemoteMode } from '../remote/remote-permissions-api.js'
import { ResourceLimitsForm } from './ResourceLimitsForm.js'
import { ResourceOccupants } from './ResourceOccupants.js'
import {
  changeResourceExecution,
  readResourceStatus,
  updateResourceLimits,
} from './resource-api.js'
import { executionKindLabel } from './resource-labels.js'

export const ResourceStatusButton = () => {
  const { confirmStop, stopConfirmation } = useRunStopConfirmation()
  const { language } = useI18n()
  const zh = language === 'zh'
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<ResourceStatus | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      try {
        const next = await readResourceStatus()
        if (!disposed) {
          setStatus(next)
          setError('')
        }
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : 'Unable to read resources')
      } finally {
        if (!disposed) timer = setTimeout(() => void read(), 2000)
      }
    }
    void read()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [open])
  if (isRemoteMode()) return null
  const mutate = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await action()
      setStatus(await readResourceStatus())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to update resources')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      {stopConfirmation}
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="topbar-knowledge-button"
          aria-label={zh ? '运行资源' : 'Runtime resources'}
        >
          <Gauge size={13} aria-hidden />
          <span>{zh ? '资源' : 'Resources'}</span>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="app-overlay fixed inset-0 z-[60]" />
        <div className="pointer-events-none fixed inset-0 z-[61] grid place-items-center p-4">
          <Dialog.Content
            className="pointer-events-auto max-h-[85vh] w-[680px] max-w-full overflow-y-auto rounded-lg border p-5"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
          >
            <div className="flex items-center justify-between gap-3">
              <Dialog.Title className="font-semibold text-pri">
                {zh ? '运行资源' : 'Runtime resources'}
              </Dialog.Title>
              <Dialog.Close asChild>
                <button type="button" className="icon-btn" aria-label={zh ? '关闭' : 'Close'}>
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>
            <Dialog.Description className="my-3 text-sm text-sec">
              {zh
                ? '统一计算 Orchestrator、Worker、工作区终端和验证执行。进程仍在运行时，即使状态为 idle 也占用名额；退出并完成回收后才释放。'
                : 'Orchestrators, workers, workspace shells and verifications share capacity. An idle agent still holds a slot while its process is running; the slot is released after exit and cleanup.'}
            </Dialog.Description>
            {error ? (
              <p role="alert" className="my-3 text-sm text-red-400">
                {error}
              </p>
            ) : null}
            {status ? (
              <>
                <p className="text-sm font-medium text-pri">
                  {zh ? '全局执行占用' : 'Global execution usage'}: {status.occupancy.global} /{' '}
                  {status.limits.max_running_total}
                </p>
                <p className="mt-2 text-xs text-sec">
                  {(Object.entries(status.occupancy.by_kind) as Array<[ExecutionKind, number]>)
                    .map(([kind, count]) => `${executionKindLabel(kind, zh)} ${count}`)
                    .join(' · ')}
                </p>
                <ul className="mt-3 space-y-2 text-xs text-sec">
                  {status.workspaces.map((workspace) => (
                    <li
                      key={workspace.workspace_id}
                      className="flex flex-wrap justify-between gap-2"
                    >
                      <span className="font-medium">{workspace.name}</span>
                      <span>
                        {zh ? '执行' : 'Executions'}{' '}
                        {status.occupancy.by_workspace[workspace.workspace_id] ?? 0}/
                        {status.limits.max_running_per_workspace} · Worker {workspace.worker_count}/
                        {status.limits.max_workers_per_workspace}
                      </span>
                    </li>
                  ))}
                </ul>
                <ResourceLimitsForm
                  key={JSON.stringify(status.limits)}
                  limits={status.limits}
                  zh={zh}
                  busy={busy}
                  save={(limits) => void mutate(() => updateResourceLimits(limits))}
                />
                <p className="text-xs text-ter">
                  {zh
                    ? '等待验证时，可以显式停止闲置成员或提高上限。验证执行可在对应任务的交付面板取消。此处限制 Hive 管理的执行数量，不是 CPU 或内存限额。'
                    : 'To unblock a verification, stop an idle agent or raise the limits. Cancel active verifications in their task delivery panel. These limits count Hive-managed executions; they are not CPU or memory limits.'}
                </p>
                <ResourceOccupants
                  status={status}
                  zh={zh}
                  busy={busy}
                  act={(path) =>
                    void mutate(async () => {
                      const match = /^\/api\/runtime\/runs\/([^/]+)\/stop$/u.exec(path)
                      if (match?.[1] && !(await confirmStop(decodeURIComponent(match[1])))) return
                      await changeResourceExecution(path)
                    })
                  }
                />
                <button
                  type="button"
                  className="icon-btn mt-4 text-xs"
                  disabled={busy}
                  onClick={() =>
                    void mutate(() => changeResourceExecution('/api/resources/reconcile'))
                  }
                >
                  {zh ? '重新核对旧进程' : 'Recheck previous processes'}
                </button>
              </>
            ) : !error ? (
              <p role="status" className="text-sm text-sec">
                {zh ? '正在读取资源占用…' : 'Loading resource usage…'}
              </p>
            ) : null}
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
