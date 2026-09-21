import { describe, expect, test } from 'vitest'

import { createAuthorizedTestRuntimeStore as createRuntimeStore } from '../helpers/authorized-runtime.js'

describe('cancel dispatch', () => {
  test('cancelTask closes an open dispatch and returns the worker to idle', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    store.getWorker(workspace.id, worker.id).status = 'idle'

    const dispatch = await store.dispatchTask(workspace.id, worker.id, 'Front-end scan')

    const result = store.cancelTask(workspace.id, dispatch.id, {
      fromAgentId: `${workspace.id}:orchestrator`,
      reason: 'Direction changed',
    })

    expect(result.dispatch).toMatchObject({
      id: dispatch.id,
      reportText: 'Direction changed',
      status: 'cancelled',
    })
    expect(store.getWorker(workspace.id, worker.id)).toMatchObject({
      pendingTaskCount: 0,
      status: 'idle',
    })
  })

  test('cancelTask decrements only the selected dispatch when multiple are open', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    store.getWorker(workspace.id, worker.id).status = 'idle'

    const first = await store.dispatchTask(workspace.id, worker.id, 'Old task')
    const second = await store.dispatchTask(workspace.id, worker.id, 'New task')

    store.cancelTask(workspace.id, first.id, {
      fromAgentId: `${workspace.id}:orchestrator`,
      reason: 'Superseded',
    })

    expect(store.listDispatches(workspace.id)).toEqual([
      expect.objectContaining({ id: first.id, status: 'cancelled' }),
      expect.objectContaining({ id: second.id, status: 'queued' }),
    ])
    expect(store.getWorker(workspace.id, worker.id)).toMatchObject({
      pendingTaskCount: 1,
      status: 'working',
    })
  })
})
