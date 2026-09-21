import type { ResourceStatus } from '../../../src/shared/resource-status.js'
import { executionKindLabel, resourceReasonLabel, resourceStateLabel } from './resource-labels.js'

export const ResourceOccupants = ({
  status,
  zh,
  busy,
  act,
}: {
  status: ResourceStatus
  zh: boolean
  busy: boolean
  act: (path: string) => void
}) => {
  const workspaceName = (id: string) =>
    status.workspaces.find((workspace) => workspace.workspace_id === id)?.name ?? id
  const queued = status.queue.filter((entry) =>
    ['queued', 'starting', 'failed'].includes(entry.status)
  )
  return (
    <>
      <h3 className="mt-5 text-sm font-semibold text-pri">
        {zh ? '占用者' : 'Executions holding capacity'}
      </h3>
      {!status.reservations.length ? (
        <p className="mt-2 text-xs text-ter">
          {zh ? '当前没有执行占用。' : 'No executions are holding capacity.'}
        </p>
      ) : (
        <ul className="mt-2 divide-y" style={{ borderColor: 'var(--border)' }}>
          {status.reservations.map((reservation) => {
            const occupant = status.occupants.find((item) => item.reservation_id === reservation.id)
            return (
              <li
                key={reservation.id}
                className="flex items-start justify-between gap-3 py-3 text-xs"
              >
                <div className="min-w-0">
                  <p className="break-words font-medium text-pri">
                    {occupant?.name ?? executionKindLabel(reservation.kind, zh)}
                  </p>
                  <p className="mt-1 text-sec">
                    {workspaceName(reservation.workspace_id)} ·{' '}
                    {executionKindLabel(reservation.kind, zh)} ·{' '}
                    {resourceStateLabel(reservation.state, zh)}
                  </p>
                  {reservation.state === 'recovery_blocked' ? (
                    <p className="mt-1 text-ter">
                      {zh
                        ? '确认旧进程退出后，点击重新核对。无法确认时继续占用名额。'
                        : 'Recheck after the previous process exits. Unconfirmed processes continue to hold capacity.'}
                    </p>
                  ) : null}
                </div>
                {occupant?.can_cancel ? (
                  <button
                    type="button"
                    className="icon-btn shrink-0"
                    disabled={busy}
                    onClick={() =>
                      act(
                        `/api/resources/reservations/${encodeURIComponent(reservation.id)}/cancel`
                      )
                    }
                  >
                    {zh ? '取消启动' : 'Cancel start'}
                  </button>
                ) : occupant?.can_stop && occupant.run_id ? (
                  <button
                    type="button"
                    className="icon-btn icon-btn--danger shrink-0"
                    disabled={busy}
                    aria-label={`${zh ? '停止' : 'Stop'} ${occupant.name}`}
                    onClick={() =>
                      act(`/api/runtime/runs/${encodeURIComponent(occupant.run_id ?? '')}/stop`)
                    }
                  >
                    {zh ? '停止' : 'Stop'}
                  </button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      <h3 className="mt-5 text-sm font-semibold text-pri">{zh ? '启动队列' : 'Start queue'}</h3>
      {!queued.length ? (
        <p className="mt-2 text-xs text-ter">
          {zh ? '没有等待资源的启动请求。' : 'No start requests are waiting for capacity.'}
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {queued.map((entry) => (
            <li
              key={entry.id}
              className="flex items-start justify-between gap-3 rounded border p-3 text-xs"
              style={{ borderColor: 'var(--border)' }}
            >
              <div className="min-w-0">
                <p className="text-pri">
                  {workspaceName(entry.workspace_id)} · {executionKindLabel(entry.kind, zh)} ·{' '}
                  {resourceStateLabel(entry.status, zh)}
                </p>
                {entry.reason ? (
                  <p className="mt-1 break-words text-sec">
                    {resourceReasonLabel(entry.reason, zh)}
                  </p>
                ) : null}
              </div>
              {entry.status === 'queued' || entry.status === 'starting' ? (
                <button
                  type="button"
                  className="icon-btn shrink-0"
                  disabled={busy}
                  onClick={() => act(`/api/resources/queue/${encodeURIComponent(entry.id)}/cancel`)}
                >
                  {zh ? '取消等待' : 'Cancel wait'}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
