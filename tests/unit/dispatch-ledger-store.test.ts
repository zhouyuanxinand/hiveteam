import { describe, expect, test } from 'vitest'

import { createDispatchLedgerStore } from '../../src/server/dispatch-ledger-store.js'
import { openRuntimeDatabase } from '../../src/server/runtime-database.js'

const createStore = () => {
  const db = openRuntimeDatabase()
  return { db, store: createDispatchLedgerStore(db) }
}

describe('dispatch ledger pending counts', () => {
  test('counts queued and submitted dispatches per worker', () => {
    const { db, store } = createStore()
    try {
      const first = store.createDispatch({ text: 'a', toAgentId: 'w1', workspaceId: 'ws' })
      store.createDispatch({ text: 'b', toAgentId: 'w1', workspaceId: 'ws' })
      store.createDispatch({ text: 'c', toAgentId: 'w2', workspaceId: 'ws' })
      store.markSubmitted(first.id)

      const counts = store.countPendingByWorker('ws')
      expect(counts.get('w1')).toBe(2)
      expect(counts.get('w2')).toBe(1)
    } finally {
      db.close()
    }
  })

  test('reported and cancelled dispatches stop counting', () => {
    const { db, store } = createStore()
    try {
      const reported = store.createDispatch({ text: 'a', toAgentId: 'w1', workspaceId: 'ws' })
      const cancelled = store.createDispatch({ text: 'b', toAgentId: 'w1', workspaceId: 'ws' })
      store.markReportedByWorker({
        artifacts: [],
        dispatchId: reported.id,
        reportText: 'done',
        toAgentId: 'w1',
        workspaceId: 'ws',
      })
      store.markCancelled({ dispatchId: cancelled.id, reason: 'no', workspaceId: 'ws' })

      expect(store.countPendingByWorker('ws').get('w1')).toBeUndefined()
    } finally {
      db.close()
    }
  })

  test('a dispatch whose last delivery failed still counts as pending', () => {
    const { db, store } = createStore()
    try {
      const dispatch = store.createDispatch({ text: 'a', toAgentId: 'w1', workspaceId: 'ws' })
      store.markDeliveryFailed(dispatch.id, 'terminal rejected input')

      expect(store.countPendingByWorker('ws').get('w1')).toBe(1)
      // The row hydrates as a failed dispatch on the list path; both views must
      // agree on what counts as pending work.
      const failed = store.listWorkspaceDispatches('ws', { status: 'failed' })
      expect(failed.map((item) => item.id)).toEqual([dispatch.id])
    } finally {
      db.close()
    }
  })

  test('counts match the legacy list-based fold', () => {
    const { db, store } = createStore()
    try {
      const keep = store.createDispatch({ text: 'keep', toAgentId: 'w1', workspaceId: 'ws' })
      const done = store.createDispatch({ text: 'done', toAgentId: 'w1', workspaceId: 'ws' })
      const failed = store.createDispatch({ text: 'fail', toAgentId: 'w2', workspaceId: 'ws' })
      store.createDispatch({ text: 'other-ws', toAgentId: 'w9', workspaceId: 'other' })
      store.markReportedByWorker({
        artifacts: [],
        dispatchId: done.id,
        reportText: 'ok',
        toAgentId: 'w1',
        workspaceId: 'ws',
      })
      store.markDeliveryFailed(failed.id, 'boom')
      void keep

      const legacy = new Map<string, number>()
      for (const dispatch of store.listWorkspaceDispatches('ws')) {
        if (
          dispatch.status === 'queued' ||
          dispatch.status === 'submitted' ||
          dispatch.status === 'failed'
        ) {
          legacy.set(dispatch.toAgentId, (legacy.get(dispatch.toAgentId) ?? 0) + 1)
        }
      }

      expect(store.countPendingByWorker('ws')).toEqual(legacy)
    } finally {
      db.close()
    }
  })
})
