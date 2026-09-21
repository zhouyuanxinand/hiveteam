import { useEffect, useState } from 'react'
import type { WorkspaceSummary } from '../../../src/shared/types.js'
import { listWorkspaces, type RemoteDevice } from '../api.js'
import { useI18n } from '../i18n.js'
import {
  approveRemoteAccess,
  rejectRemoteAccess,
  remoteActionLabel,
  revokeRemoteGrant,
  setRemoteReadScopes,
} from './remote-permissions-api.js'
import { useRemoteAccess } from './useRemoteAccess.js'

export const RemoteDevicePermissions = ({ device }: { device: RemoteDevice }) => {
  const { language } = useI18n()
  const zh = language === 'zh'
  const { access, remaining, refresh, error: loadError } = useRemoteAccess(device.id)
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [scopes, setScopes] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    void listWorkspaces().then(
      (items) => {
        if (!cancelled) setWorkspaces(items)
      },
      (cause: unknown) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : 'Unable to load workspaces')
      }
    )
    return () => {
      cancelled = true
    }
  }, [])
  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await operation()
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to update access')
    } finally {
      setBusy(false)
    }
  }
  const selected = scopes ?? access?.workspace_ids ?? []
  return (
    <details className="rounded border px-3 py-2 text-xs" style={{ borderColor: 'var(--border)' }}>
      <summary className="cursor-pointer text-sec">
        {zh ? `${device.name} 的访问权限` : `Access for ${device.name}`}
      </summary>
      <p className="my-2 text-ter">
        {zh
          ? '默认无写权限。先选择允许查看的工作区，再审批该设备的临时写入申请。'
          : 'No write access by default. Choose visible workspaces, then approve individual requests below.'}
      </p>
      {loadError || error ? (
        <p role="alert" className="my-2 text-red-400">
          {error || loadError}
        </p>
      ) : null}
      <fieldset disabled={busy || !access} className="space-y-2">
        <legend className="mb-2 font-medium text-pri">
          {zh ? '允许查看的工作区' : 'Visible workspaces'}
        </legend>
        {workspaces.map((workspace) => (
          <label key={workspace.id} className="flex items-center gap-2 text-sec">
            <input
              type="checkbox"
              checked={selected.includes(workspace.id)}
              onChange={(event) => {
                setScopes(
                  event.target.checked
                    ? [...selected, workspace.id]
                    : selected.filter((id) => id !== workspace.id)
                )
              }}
            />
            {workspace.name}
          </label>
        ))}
        <button
          type="button"
          className="icon-btn"
          disabled={scopes === null}
          onClick={() =>
            void run(async () => {
              await setRemoteReadScopes(device.id, selected)
              setScopes(null)
            })
          }
        >
          {zh ? '保存读取范围' : 'Save read access'}
        </button>
      </fieldset>
      {access?.requests
        .filter((request) => request.status === 'pending')
        .map((request) => (
          <div
            key={request.id}
            className="mt-3 rounded border p-2"
            style={{ borderColor: 'var(--border)' }}
          >
            <p className="font-medium text-pri">
              {request.device_name} · {request.workspace_name}
            </p>
            <p className="mt-1 text-sec">
              {request.actions.map((action) => remoteActionLabel(action, zh)).join(' · ')}
            </p>
            <p className="my-2 text-ter">
              {Math.ceil(request.duration_ms / 60_000)}{' '}
              {zh ? '分钟；重启后失效' : 'minutes; expires on runtime restart'}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className="icon-btn icon-btn--primary"
                disabled={busy}
                onClick={() => void run(() => approveRemoteAccess(request.id))}
              >
                {zh ? '批准本次申请' : 'Approve request'}
              </button>
              <button
                type="button"
                className="icon-btn"
                disabled={busy}
                onClick={() => void run(() => rejectRemoteAccess(request.id))}
              >
                {zh ? '拒绝' : 'Reject'}
              </button>
            </div>
          </div>
        ))}
      {access?.grants
        .filter((grant) => remaining(grant.remaining_ms) > 0)
        .map((grant) => (
          <div
            key={grant.id}
            className="mt-3 rounded border p-2"
            style={{ borderColor: 'var(--border)' }}
          >
            <p className="text-pri">
              {workspaces.find((workspace) => workspace.id === grant.workspace_id)?.name ??
                grant.workspace_id}
            </p>
            <p className="my-1 text-sec">
              {grant.actions.map((action) => remoteActionLabel(action, zh)).join(' · ')}
            </p>
            <p className="text-ter">
              {zh ? '剩余' : 'Remaining'} {Math.ceil(remaining(grant.remaining_ms) / 1000)}s
            </p>
            <button
              type="button"
              className="icon-btn icon-btn--danger mt-2"
              disabled={busy}
              onClick={() => void run(() => revokeRemoteGrant(grant.id))}
            >
              {zh ? '立即撤销' : 'Revoke now'}
            </button>
          </div>
        ))}
    </details>
  )
}
