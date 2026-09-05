import { describe, expect, test, vi } from 'vitest'

import type { ReportOutboxEntry } from '../../src/server/report-outbox-store.js'
import { createTeamOperations } from '../../src/server/team-operations.js'

const makeEntry = (
  id: number,
  input: { deliveryAttemptCount?: number; lastDeliveryAttemptAt?: number | null } = {}
): ReportOutboxEntry => ({
  createdAt: 1_700_000_000_000,
  deliveryAttemptCount: input.deliveryAttemptCount ?? 0,
  deliveredAt: null,
  dispatchId: `dispatch-${id}`,
  id,
  lastDeliveryAttemptAt: input.lastDeliveryAttemptAt ?? null,
  lastDeliveryError: null,
  payload: 'payload',
  targetAgentId: 'workspace-1:orchestrator',
  workspaceId: 'workspace-1',
})

const createHarness = (entries: ReportOutboxEntry[]) => {
  const deliverSystemMessageToAgent = vi.fn(() => new Promise<void>(() => {}))
  const reportOutbox = {
    listPending: vi.fn(() => entries),
    markDelivered: vi.fn(),
    markDeliveryAttempt: vi.fn(),
    markDeliveryFailed: vi.fn(),
  }
  const ops = createTeamOperations({
    agentRuntime: {
      deliverSystemMessageToAgent,
      getActiveRunByAgentId: vi.fn(() => ({ runId: 'run-1' })),
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
    reportOutbox: reportOutbox as never,
    workspaceStore: {} as never,
  })
  return { deliverSystemMessageToAgent, ops, reportOutbox }
}

describe('report outbox delivery backoff', () => {
  test('attempts fresh and once-failed entries immediately, then backs off', () => {
    const now = Date.now()
    const { deliverSystemMessageToAgent, ops, reportOutbox } = createHarness([
      makeEntry(1),
      // Failed once seconds ago: the first retry stays immediate so a
      // transient paste race recovers at the next drain event.
      makeEntry(2, { deliveryAttemptCount: 1, lastDeliveryAttemptAt: now - 1_000 }),
      // Failed twice 10s ago; the backoff after two attempts is 60s.
      makeEntry(3, { deliveryAttemptCount: 2, lastDeliveryAttemptAt: now - 10_000 }),
      // Failed twice two minutes ago; the 60s window has elapsed.
      makeEntry(4, { deliveryAttemptCount: 2, lastDeliveryAttemptAt: now - 120_000 }),
    ])

    const result = ops.drainReportOutbox('workspace-1')

    expect(reportOutbox.markDeliveryAttempt.mock.calls.map((call) => call[0])).toEqual([1, 2, 4])
    expect(deliverSystemMessageToAgent).toHaveBeenCalledTimes(3)
    expect(result.attempted).toBe(3)
  })

  test('backoff grows exponentially and is capped at thirty minutes', () => {
    const now = Date.now()
    const { deliverSystemMessageToAgent, ops, reportOutbox } = createHarness([
      // Four attempts failed 3 minutes ago; backoff is 30s * 2^3 = 4 minutes.
      makeEntry(1, { deliveryAttemptCount: 4, lastDeliveryAttemptAt: now - 180_000 }),
      // Same attempt count, 5 minutes ago — outside the window.
      makeEntry(2, { deliveryAttemptCount: 4, lastDeliveryAttemptAt: now - 300_000 }),
      // Many attempts 20 minutes ago; the 30 minute cap still suppresses it.
      makeEntry(3, { deliveryAttemptCount: 20, lastDeliveryAttemptAt: now - 20 * 60_000 }),
      // Many attempts 40 minutes ago — beyond the cap, so it retries.
      makeEntry(4, { deliveryAttemptCount: 20, lastDeliveryAttemptAt: now - 40 * 60_000 }),
    ])

    const result = ops.drainReportOutbox('workspace-1')

    expect(reportOutbox.markDeliveryAttempt.mock.calls.map((call) => call[0])).toEqual([2, 4])
    expect(deliverSystemMessageToAgent).toHaveBeenCalledTimes(2)
    expect(result.attempted).toBe(2)
  })

  test('does nothing while the orchestrator has no active run', () => {
    const { reportOutbox } = createHarness([makeEntry(1)])
    const opsWithoutRun = createTeamOperations({
      agentRuntime: {
        deliverSystemMessageToAgent: vi.fn(),
        getActiveRunByAgentId: vi.fn(() => undefined),
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
      reportOutbox: reportOutbox as never,
      workspaceStore: {} as never,
    })

    const result = opsWithoutRun.drainReportOutbox('workspace-1')
    expect(result).toEqual({ attempted: 0, firstSyncError: null })
    expect(reportOutbox.markDeliveryAttempt).not.toHaveBeenCalled()
  })
})
