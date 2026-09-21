import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import {
  createResourceBudgetStore,
  type ReserveExecutionInput,
} from '../../src/server/resource-budget-store.js'
import { openRuntimeDatabase } from '../../src/server/runtime-database.js'
import { acquireRuntimeOwner } from '../../src/server/runtime-owner-lock.js'

const [mode, directory, instance] = process.argv.slice(2)
if (!directory) throw new Error('A fixture data directory is required')
const activeChildren = new Set<ChildProcess>()
const startChild = async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
    detached: true,
  })
  activeChildren.add(child)
  await once(child, 'spawn')
  return child
}
const send = (message: unknown) => process.send?.(message)
const failure = (error: unknown) => ({
  type: 'error',
  code: error && typeof error === 'object' && 'code' in error ? error.code : 'unexpected',
  message: error instanceof Error ? error.message : String(error),
})

try {
  const owner = mode === 'writer' ? undefined : acquireRuntimeOwner(directory)
  // Writer contention targets admission on an already migrated database.
  // Production schema initialization runs once under the runtime owner lock.
  const db =
    mode === 'owner'
      ? undefined
      : mode === 'writer'
        ? new BetterSqlite3(join(directory, 'runtime.sqlite'), { fileMustExist: true })
        : openRuntimeDatabase(directory)
  db?.pragma('foreign_keys = ON')
  const resources = db
    ? createResourceBudgetStore(db, {
        runtimeInstanceId: instance ?? owner?.runtimeInstanceId ?? randomUUID(),
      })
    : undefined
  process.on(
    'message',
    (packet: {
      operation: string
      input: ReserveExecutionInput
      phase?: string
      count?: number
    }) => {
      void (async () => {
        if (packet.operation === 'close') {
          for (const child of activeChildren) {
            const exited = once(child, 'exit')
            child.kill('SIGKILL')
            await exited
          }
          db?.close()
          owner?.close()
          process.disconnect?.()
          return
        }
        if (!resources || !db) throw new Error('A budget store is required')
        if (packet.operation === 'members') {
          resources.withTransaction(() => {
            resources.assertWorkerCapacityInTransaction(packet.input.workspaceId, packet.count ?? 0)
            for (let index = 0; index < (packet.count ?? 0); index += 1)
              db.prepare(
                `INSERT INTO workers(id,workspace_id,name,role,created_at) VALUES(?,?,?,?,?)`
              ).run(randomUUID(), packet.input.workspaceId, `worker ${index}`, 'coder', Date.now())
          })
          send({ type: 'members', count: packet.count })
          return
        }
        const reservation = resources.reserve(packet.input)
        if (packet.phase !== 'reserved') resources.beginSpawn(reservation.id)
        let child: ChildProcess | undefined
        if (packet.phase !== 'reserved' && packet.phase !== 'intent_only')
          child = await startChild()
        if (child && packet.phase !== 'spawn_unknown')
          resources.markStarted(reservation.id, {
            runId: randomUUID(),
            pid: child.pid ?? null,
            startedAt: Date.now(),
          })
        send({
          type: 'reserved',
          reservation: resources.getReservation(reservation.id),
          pid: child?.pid ?? null,
        })
      })().catch((error: unknown) => send(failure(error)))
    }
  )
  send({
    type: 'ready',
    runtime_instance_id: resources?.runtimeInstanceId ?? owner?.runtimeInstanceId,
  })
} catch (error) {
  send(failure(error))
  process.exitCode = 1
  process.disconnect?.()
}
