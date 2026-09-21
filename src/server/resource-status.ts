import type { ResourceStatus } from '../shared/resource-status.js'
import type { RuntimeStore } from './runtime-store.js'

export const readResourceStatus = (store: RuntimeStore): ResourceStatus => {
  const snapshot = store.resources.getSnapshot()
  const workspaces = store.listWorkspaces()
  const records = workspaces.map((workspace) => store.getWorkspaceSnapshot(workspace.id))
  const agents = new Map(
    records.flatMap((workspace) => workspace.agents.map((agent) => [agent.id, agent] as const))
  )
  const runs = new Map(
    workspaces.flatMap((workspace) =>
      store.listTerminalRuns(workspace.id).map((run) => [run.run_id, run] as const)
    )
  )
  return {
    ...snapshot,
    queue: store.resourceQueue.list(),
    workspaces: records.map((workspace) => ({
      workspace_id: workspace.summary.id,
      name: workspace.summary.name,
      worker_count: workspace.agents.filter((agent) => agent.role !== 'orchestrator').length,
    })),
    occupants: snapshot.reservations.map((reservation) => {
      const agent = reservation.agent_id ? agents.get(reservation.agent_id) : undefined
      const run = reservation.run_id ? runs.get(reservation.run_id) : undefined
      return {
        reservation_id: reservation.id,
        name: agent?.name ?? run?.agent_name ?? reservation.kind,
        run_id: reservation.run_id,
        can_stop: Boolean(run && ['starting', 'running'].includes(run.status)),
        can_cancel: Boolean(
          agent &&
            reservation.state === 'reserved' &&
            reservation.runtime_instance_id === store.resources.runtimeInstanceId &&
            (reservation.kind === 'worker' || reservation.kind === 'orchestrator')
        ),
      }
    }),
  }
}
