import * as Dialog from '@radix-ui/react-dialog'
import { LockKeyhole, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { REMOTE_ACTIONS, type RemoteAction } from '../../../src/shared/remote-permissions.js'
import type { WorkspaceSummary } from '../../../src/shared/types.js'
import { listWorkspaces } from '../api.js'
import { useI18n } from '../i18n.js'
import { remoteActionLabel, requestRemoteAccess } from './remote-permissions-api.js'
import { useRemoteAccess } from './useRemoteAccess.js'

export const RemotePermissionStatus = () => {
  const { language } = useI18n()
  const zh = language === 'zh'
  const { access, remaining, refresh, error: loadError } = useRemoteAccess()
  const [open, setOpen] = useState(false)
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [workspaceId, setWorkspaceId] = useState('')
  const [actions, setActions] = useState<RemoteAction[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const workspaceKey = access?.workspace_ids.join(',') ?? ''
  useEffect(() => {
    if (!workspaceKey) {
      setWorkspaces([])
      setWorkspaceId('')
      return
    }
    let cancelled = false
    void listWorkspaces().then(
      (items) => {
        if (cancelled) return
        setWorkspaces(items)
        setWorkspaceId((current) =>
          items.some((item) => item.id === current) ? current : (items[0]?.id ?? '')
        )
      },
      (cause: unknown) => {
        if (!cancelled)
          setMessage(cause instanceof Error ? cause.message : 'Unable to load workspaces')
      }
    )
    return () => {
      cancelled = true
    }
  }, [workspaceKey])
  const activeGrants = access?.grants.filter((grant) => remaining(grant.remaining_ms) > 0) ?? []
  const maxRemaining = Math.max(0, ...activeGrants.map((grant) => remaining(grant.remaining_ms)))
  const requestAccess = async () => {
    setBusy(true)
    setMessage('')
    try {
      await requestRemoteAccess(workspaceId, actions)
      await refresh()
      setMessage(
        zh
          ? '申请已发送，等待本机批准。'
          : 'Request sent. Waiting for approval on the local computer.'
      )
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="topbar-knowledge-button"
          data-testid="remote-permission-status"
        >
          <LockKeyhole size={13} aria-hidden />
          <span>
            {maxRemaining > 0
              ? `${zh ? '临时授权' : 'Temporary access'} ${Math.ceil(maxRemaining / 1000)}s`
              : zh
                ? '只读访问'
                : 'Read-only access'}
          </span>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="app-overlay fixed inset-0 z-40" />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Content
            className="pointer-events-auto max-h-[85vh] w-[460px] max-w-full overflow-y-auto rounded-lg border p-5"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
          >
            <div className="flex items-center justify-between gap-3">
              <Dialog.Title className="font-semibold text-pri">
                {zh ? '此设备的访问权限' : 'Access for this device'}
              </Dialog.Title>
              <Dialog.Close asChild>
                <button type="button" className="icon-btn" aria-label={zh ? '关闭' : 'Close'}>
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>
            <Dialog.Description className="my-3 text-sm text-sec">
              {zh
                ? '只可查看本机允许的工作区。写入需要本机批准；到期后停止接收新输入，已经启动的任务可以继续运行。'
                : 'View only workspaces allowed by the local computer. Writes require local approval. Expiry blocks new input; tasks already started may continue.'}
            </Dialog.Description>
            {loadError ? (
              <p role="alert" className="mb-3 text-sm text-red-400">
                {loadError}
              </p>
            ) : null}
            {activeGrants.map((grant) => (
              <div
                key={grant.id}
                className="mb-3 rounded border p-2 text-xs"
                style={{ borderColor: 'var(--border)' }}
              >
                <p className="font-medium text-pri">
                  {workspaces.find((workspace) => workspace.id === grant.workspace_id)?.name ??
                    grant.workspace_id}{' '}
                  · {Math.ceil(remaining(grant.remaining_ms) / 1000)}s
                </p>
                <p className="mt-1 text-sec">
                  {grant.actions.map((action) => remoteActionLabel(action, zh)).join(' · ')}
                </p>
              </div>
            ))}
            {workspaces.length === 0 ? (
              <p className="text-sm text-sec">
                {zh
                  ? '请在本机的远程设备面板选择允许查看的工作区。'
                  : 'Choose visible workspaces in the local remote-device panel first.'}
              </p>
            ) : (
              <fieldset disabled={busy || !access} className="space-y-3">
                <legend className="mb-2 font-medium text-pri">
                  {zh ? '申请 10 分钟写权限' : 'Request 10 minutes of write access'}
                </legend>
                <label className="block text-sm text-sec">
                  {zh ? '工作区' : 'Workspace'}
                  <select
                    className="mt-1 w-full rounded border bg-transparent p-2"
                    value={workspaceId}
                    onChange={(event) => setWorkspaceId(event.target.value)}
                  >
                    {workspaces.map((workspace) => (
                      <option key={workspace.id} value={workspace.id}>
                        {workspace.name}
                      </option>
                    ))}
                  </select>
                </label>
                {REMOTE_ACTIONS.map((action) => (
                  <label key={action} className="flex items-center gap-2 text-sm text-sec">
                    <input
                      type="checkbox"
                      checked={actions.includes(action)}
                      onChange={(event) =>
                        setActions(
                          event.target.checked
                            ? [...actions, action]
                            : actions.filter((item) => item !== action)
                        )
                      }
                    />
                    {remoteActionLabel(action, zh)}
                  </label>
                ))}
                <button
                  type="button"
                  className="btn-primary"
                  disabled={!workspaceId || !actions.length}
                  onClick={() => void requestAccess()}
                >
                  {zh ? '发送申请' : 'Send request'}
                </button>
              </fieldset>
            )}
            {access?.requests.slice(0, 5).map((request) => (
              <p key={request.id} className="mt-3 text-xs text-ter">
                {request.workspace_name} ·{' '}
                {request.status === 'pending'
                  ? zh
                    ? '等待本机批准'
                    : 'Awaiting local approval'
                  : request.status}
              </p>
            ))}
            {message ? (
              <p role="status" className="mt-3 text-sm text-sec">
                {message}
              </p>
            ) : null}
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
