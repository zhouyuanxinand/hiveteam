import Database from 'better-sqlite3'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createReportOutboxStore } from '../../src/server/report-outbox-store.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createTeamOperations } from '../../src/server/team-operations.js'
import { rejectUnexpectedTeamSkillOperations } from '../helpers/team-skill-stubs.js'

const databases: Database.Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

const createHarness = (attempts: number, elapsed: number, running = true) => {
  const db = new Database(':memory:')
  databases.push(db)
  initializeRuntimeDatabase(db)
  const reportOutbox = createReportOutboxStore(db)
  for (const id of ['first', 'second'])
    reportOutbox.enqueue({
      dispatchId: id,
      workspaceId: 'workspace-1',
      targetAgentId: 'workspace-1:orchestrator',
      payload: id,
    })
  db.prepare(
    'UPDATE report_outbox SET delivery_attempts = ?, last_delivery_attempt_at = ? WHERE dispatch_id = ?'
  ).run(attempts, Date.now() - elapsed, 'first')
  const ops = createTeamOperations({
    ...rejectUnexpectedTeamSkillOperations,
    agentRuntime: {
      deliverSystemMessageToAgent: () => new Promise<void>(() => {}),
      getActiveRunByAgentId: () => (running ? { runId: 'run-1' } : undefined),
    } as never,
    createDispatch: vi.fn() as never,
    deleteDispatch: vi.fn(),
    deleteMessage: vi.fn(),
    findOpenDispatch: vi.fn(),
    findOpenDispatchById: vi.fn(),
    insertMessage: vi.fn() as never,
    markDispatchCancelled: vi.fn(),
    markDispatchReportedByWorker: vi.fn(),
    markDispatchSubmitted: vi.fn(),
    reportOutbox,
    workspaceStore: {} as never,
  })
  return { ops, pending: () => reportOutbox.listPending('workspace-1', 'workspace-1:orchestrator') }
}

describe('report outbox backoff and single-composer ordering', () => {
  test.each([
    [0, 0, 1],
    [1, 1_000, 1],
    [2, 10_000, 0],
    [2, 120_000, 1],
    [4, 180_000, 0],
    [4, 300_000, 1],
    [20, 20 * 60_000, 0],
    [20, 40 * 60_000, 1],
  ])('attempts=%i elapsed=%i eligible=%i', (attempts, elapsed, eligible) => {
    const { ops, pending } = createHarness(attempts, elapsed)
    ops.drainReportOutbox('workspace-1')
    // Repeated polling must not paste the next report into the same composer.
    ops.drainReportOutbox('workspace-1')
    expect(
      pending().map((entry) => [entry.dispatchId, entry.deliveryAttemptCount, entry.deliveredAt])
    ).toEqual([
      ['first', attempts + eligible, null],
      ['second', 0, null],
    ])
  })
  test('retains both reports without attempting input while the Orchestrator is stopped', () => {
    const { ops, pending } = createHarness(0, 0, false)
    ops.drainReportOutbox('workspace-1')
    expect(pending().map((entry) => entry.deliveryAttemptCount)).toEqual([0, 0])
  })
})
