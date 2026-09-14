import { describe, expect, test } from 'vitest'
import { createDispatchLedgerStore } from '../../src/server/dispatch-ledger-store.js'
import { openRuntimeDatabase } from '../../src/server/runtime-database.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

describe('dispatch result migration', () => {
  test('preserves legacy reports without declaring success or acceptance', () => {
    const db = openRuntimeDatabase()
    try {
      const store = createDispatchLedgerStore(db)
      const dispatch = store.createDispatch({
        workspaceId: 'ws',
        toAgentId: 'worker',
        text: 'Legacy task',
      })
      store.markReportedByWorker({
        workspaceId: 'ws',
        toAgentId: 'worker',
        dispatchId: dispatch.id,
        reportText: 'Legacy report',
        artifacts: ['result.txt'],
      })
      db.exec(
        'ALTER TABLE dispatches DROP COLUMN report_outcome; ALTER TABLE dispatches DROP COLUMN report_revision; ALTER TABLE dispatches DROP COLUMN accepted_at; DELETE FROM schema_version WHERE version = 38;'
      )
      initializeRuntimeDatabase(db)
      initializeRuntimeDatabase(db)
      expect(createDispatchLedgerStore(db).getDispatchById('ws', dispatch.id)).toMatchObject({
        reportText: 'Legacy report',
        artifacts: ['result.txt'],
        reportOutcome: null,
        reportRevision: 1,
        acceptedAt: null,
      })
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM schema_version WHERE version = 38').get()
      ).toEqual({ count: 1 })
    } finally {
      db.close()
    }
  })
})
