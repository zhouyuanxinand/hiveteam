import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createDispatchLedgerStore } from '../../src/server/dispatch-ledger-store.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createWorkerLifecycleStore } from '../../src/server/worker-lifecycle-store.js'
import { createWorkspaceStore } from '../../src/server/workspace-store.js'

const databases: Database[] = [],
  directories: string[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-worker-lifecycle-'))
  directories.push(dir)
  const path = join(dir, 'runtime.sqlite')
  const db = new Database(path)
  databases.push(db)
  db.pragma('journal_mode=WAL')
  initializeRuntimeDatabase(db)
  const workspaces = createWorkspaceStore(db, [])
  const workspace = workspaces.createWorkspace(dir, 'Lifecycle', 'en')
  const worker = workspaces.addWorker(workspace.id, {
    name: 'Temporary',
    role: 'coder',
    spawnedByAgentId: `${workspace.id}:orchestrator`,
  })
  const second = new Database(path)
  databases.push(second)
  const ledger = createDispatchLedgerStore(second)
  const lifecycle = createWorkerLifecycleStore(db)
  const send = () =>
    ledger.createDispatch({ workspaceId: workspace.id, toAgentId: worker.id, text: 'Build' })
  return { db, second, workspaces, workspace, worker, ledger, lifecycle, send }
}
test.each([
  'send',
  'retire',
] as const)('two SQLite connections enforce the %s-first commit order', (first) => {
  const f = setup()
  if (first === 'send') {
    const dispatch = f.send()
    expect(() => f.workspaces.retireWorker(f.workspace.id, f.worker.id)).toThrow('open dispatches')
    expect(
      f.db.prepare('SELECT retired_at,manual_stop FROM workers WHERE id=?').get(f.worker.id)
    ).toEqual({ retired_at: null, manual_stop: 0 })
    expect(f.workspaces.getWorker(f.workspace.id, f.worker.id).retiredAt).toBeUndefined()
    f.ledger.markCancelled({
      workspaceId: f.workspace.id,
      dispatchId: dispatch.id,
      reason: 'No longer needed',
    })
    f.workspaces.retireWorker(f.workspace.id, f.worker.id)
    expect(f.ledger.getDispatchById(f.workspace.id, dispatch.id)?.status).toBe('cancelled')
  } else {
    f.workspaces.retireWorker(f.workspace.id, f.worker.id)
    expect(f.send).toThrow('retired')
    expect(f.second.prepare('SELECT * FROM dispatches').all()).toEqual([])
    expect(f.second.prepare('SELECT * FROM message_deliveries').all()).toEqual([])
  }
  expect(f.workspaces.listWorkers(f.workspace.id)).toEqual([])
  expect(f.workspaces.getWorker(f.workspace.id, f.worker.id)).toMatchObject({
    status: 'stopped',
    retiredAt: expect.any(Number),
  })
})
test('retirement prevents reopening reports and preserves their content', () => {
  const f = setup(),
    dispatch = f.send()
  f.ledger.markReportedByWorker({
    workspaceId: f.workspace.id,
    toAgentId: f.worker.id,
    dispatchId: dispatch.id,
    reportText: 'Completed',
    artifacts: ['result.txt'],
  })
  const before = f.ledger.getDispatchById(f.workspace.id, dispatch.id)
  const first = f.workspaces.retireWorker(f.workspace.id, f.worker.id).retiredAt
  expect(f.workspaces.retireWorker(f.workspace.id, f.worker.id).retiredAt).toBe(first)
  expect(() => f.ledger.reopenReportedDispatch(f.workspace.id, dispatch.id)).toThrow('retired')
  expect(f.ledger.getDispatchById(f.workspace.id, dispatch.id)).toEqual(before)
  expect(() => f.workspaces.markAgentStarted(f.workspace.id, f.worker.id)).toThrow('retired')
  expect(f.db.prepare('SELECT manual_stop FROM workers WHERE id=?').get(f.worker.id)).toEqual({
    manual_stop: 1,
  })
})
test('admission rolls back worker creation and cached state at the dynamic cap', () => {
  const f = setup()
  f.lifecycle.updatePolicy(f.workspace.id, {
    enabled: true,
    allowed_command_preset_ids: ['preset'],
    max_ephemeral_workers: 1,
  })
  const add = () =>
    f.workspaces.addWorkers(
      f.workspace.id,
      [{ name: 'Second', role: 'tester', spawnedByAgentId: `${f.workspace.id}:orchestrator` }],
      () => f.lifecycle.admitSpawn(f.workspace.id, 'preset')
    )
  expect(add).toThrow('limit reached')
  expect(f.db.prepare('SELECT name FROM workers').all()).toEqual([{ name: 'Temporary' }])
  expect(f.workspaces.listWorkers(f.workspace.id).map((worker) => worker.name)).toEqual([
    'Temporary',
  ])
  f.workspaces.retireWorker(f.workspace.id, f.worker.id)
  const [second] = add()
  expect(f.workspaces.listWorkers(f.workspace.id).map((worker) => worker.id)).toEqual([second?.id])
})
test('restart keeps a failed preparation blocked and retains all retired records', () => {
  const f = setup()
  const pending = f.workspaces.addWorker(f.workspace.id, {
    name: 'Preparing',
    role: 'reviewer',
    preparing: true,
  })
  f.workspaces.retireWorker(f.workspace.id, f.worker.id)
  const restored = createWorkspaceStore(f.second, [])
  expect(restored.getWorker(f.workspace.id, pending.id)).toMatchObject({
    status: 'stopped',
    preparationState: 'failed',
    preparationError: expect.stringContaining('interrupted'),
  })
  expect(() => restored.markAgentStarted(f.workspace.id, pending.id)).toThrow('interrupted')
  expect(restored.listWorkers(f.workspace.id).map((worker) => worker.id)).toEqual([pending.id])
  expect(restored.getWorker(f.workspace.id, f.worker.id).retiredAt).toEqual(expect.any(Number))
  expect(f.second.pragma('foreign_key_check')).toEqual([])
})
