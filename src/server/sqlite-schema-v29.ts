import type { Database } from 'better-sqlite3'

/**
 * Removes the retired Sentinel role and any persisted workers created with it.
 *
 * Sentinel was an internal coordination role, not a user-selectable worker
 * contract. Leaving legacy rows in place makes hydration cast an unsupported
 * role into WorkerRole and can break the restored team. Delete only the stale
 * Sentinel records and their direct runtime artefacts; other workers, history,
 * and workspace settings remain untouched.
 */
export const applySchemaVersion29 = (db: Database) => {
  const tableNames = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string
      }>
    ).map((row) => row.name)
  )
  const hasTable = (name: string) => tableNames.has(name)
  const getColumns = (table: string) =>
    new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )

  const roleTemplateColumns = hasTable('role_templates') ? getColumns('role_templates') : new Set()
  const deleteSentinelTemplate =
    roleTemplateColumns.has('id') && roleTemplateColumns.has('role_type')
      ? db.prepare("DELETE FROM role_templates WHERE id = 'sentinel' OR role_type = 'sentinel'")
      : null

  if (!hasTable('workers') || !getColumns('workers').has('role')) {
    deleteSentinelTemplate?.run()
    return
  }

  const sentinelWorkers = db
    .prepare("SELECT workspace_id, id FROM workers WHERE role = 'sentinel'")
    .all() as Array<{ id: string; workspace_id: string }>

  const deleteMessages = hasTable('messages')
    ? db.prepare(`DELETE FROM messages
       WHERE workspace_id = ?
         AND (worker_id = ? OR from_agent_id = ? OR to_agent_id = ?)`)
    : null
  const deleteReportOutbox =
    hasTable('report_outbox') && hasTable('dispatches')
      ? db.prepare(`DELETE FROM report_outbox
       WHERE workspace_id = ?
         AND (
           target_agent_id = ?
           OR dispatch_id IN (
             SELECT id FROM dispatches
             WHERE workspace_id = ? AND (from_agent_id = ? OR to_agent_id = ?)
           )
         )`)
      : null
  const deleteDeliveryFailures =
    hasTable('dispatch_delivery_failures') && hasTable('dispatches')
      ? db.prepare(`DELETE FROM dispatch_delivery_failures
       WHERE dispatch_id IN (
         SELECT id FROM dispatches
         WHERE workspace_id = ? AND (from_agent_id = ? OR to_agent_id = ?)
       )`)
      : null
  const deleteDreamReviews =
    hasTable('memory_dream_reviews') && hasTable('dispatches')
      ? db.prepare(`DELETE FROM memory_dream_reviews
       WHERE workspace_id = ?
         AND (
           worker_id = ?
           OR dispatch_id IN (
             SELECT id FROM dispatches
             WHERE workspace_id = ? AND (from_agent_id = ? OR to_agent_id = ?)
           )
         )`)
      : null
  const deleteDispatches = hasTable('dispatches')
    ? db.prepare(
        'DELETE FROM dispatches WHERE workspace_id = ? AND (from_agent_id = ? OR to_agent_id = ?)'
      )
    : null
  const deleteLaunchConfig = hasTable('agent_launch_configs')
    ? db.prepare('DELETE FROM agent_launch_configs WHERE workspace_id = ? AND agent_id = ?')
    : null
  const deleteSession = hasTable('agent_sessions')
    ? db.prepare('DELETE FROM agent_sessions WHERE workspace_id = ? AND agent_id = ?')
    : null
  const deleteRun = hasTable('agent_runs')
    ? db.prepare('DELETE FROM agent_runs WHERE agent_id = ?')
    : null
  const deleteWorker = db.prepare('DELETE FROM workers WHERE workspace_id = ? AND id = ?')

  db.transaction(() => {
    deleteSentinelTemplate?.run()
    for (const worker of sentinelWorkers) {
      deleteMessages?.run(worker.workspace_id, worker.id, worker.id, worker.id)
      deleteReportOutbox?.run(
        worker.workspace_id,
        worker.id,
        worker.workspace_id,
        worker.id,
        worker.id
      )
      deleteDeliveryFailures?.run(worker.workspace_id, worker.id, worker.id)
      deleteDreamReviews?.run(
        worker.workspace_id,
        worker.id,
        worker.workspace_id,
        worker.id,
        worker.id
      )
      deleteDispatches?.run(worker.workspace_id, worker.id, worker.id)
      deleteLaunchConfig?.run(worker.workspace_id, worker.id)
      deleteSession?.run(worker.workspace_id, worker.id)
      deleteRun?.run(worker.id)
      deleteWorker.run(worker.workspace_id, worker.id)
    }
  })()
}
