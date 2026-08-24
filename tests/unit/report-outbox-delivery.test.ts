import Database from 'better-sqlite3'
import { describe, expect, test, vi } from 'vitest'

import { createReportOutboxStore } from '../../src/server/report-outbox-store.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createTeamOperations } from '../../src/server/team-operations.js'

describe('report outbox delivery', () => {
  test('persists a report while the Orchestrator is down and replays it after recovery', async () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    const reportOutbox = createReportOutboxStore(db)
    const workspaceId = 'workspace-1'
    const workerId = 'worker-1'
    const orchestratorId = `${workspaceId}:orchestrator`
    const dispatch = {
      artifacts: [],
      createdAt: 1,
      deliveredAt: null,
      fromAgentId: orchestratorId,
      id: 'dispatch-1',
      reportedAt: null,
      reportText: null,
      sequence: 1,
      status: 'submitted' as const,
      submittedAt: 1,
      text: 'Implement the login flow',
      toAgentId: workerId,
      workspaceId,
    }
    const reportedDispatch = {
      ...dispatch,
      artifacts: ['src/login.ts'],
      reportText: 'Login flow implemented',
      status: 'reported' as const,
    }
    let orchestratorRunning = false
    const deliverSystemMessageToAgent = vi.fn(() => Promise.resolve())
    const markTaskReported = vi.fn()
    const ops = createTeamOperations({
      agentRuntime: {
        deliverSystemMessageToAgent,
        getActiveRunByAgentId: vi.fn(() =>
          orchestratorRunning ? { runId: 'orchestrator-run' } : undefined
        ),
        writeReportPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage: vi.fn(),
      findOpenDispatch: vi.fn(() => dispatch),
      findOpenDispatchById: vi.fn(),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchCancelled: vi.fn(),
      markDispatchReportedByWorker: vi.fn(() => reportedDispatch),
      markDispatchSubmitted: vi.fn(),
      reportOutbox,
      runDataMutation: (mutation) => db.transaction(mutation)(),
      workspaceStore: {
        getWorker: vi.fn(() => ({ id: workerId, name: 'Alice' })),
        markTaskReported,
      } as never,
    })

    const result = ops.reportTask(workspaceId, workerId, {
      artifacts: ['src/login.ts'],
      requireActiveRun: true,
      text: 'Login flow implemented',
    })

    expect(result).toEqual({
      deliveryState: 'queued',
      dispatch: reportedDispatch,
      forwardError: 'Orchestrator is not running; report queued for delivery.',
      forwarded: false,
    })
    expect(markTaskReported).toHaveBeenCalledWith(workspaceId, workerId)
    expect(reportOutbox.pendingCount(workspaceId, orchestratorId)).toBe(1)
    expect(reportOutbox.listPending(workspaceId, orchestratorId)).toEqual([
      expect.objectContaining({
        dispatchId: dispatch.id,
        payload: expect.stringContaining('Login flow implemented'),
      }),
    ])

    orchestratorRunning = true
    expect(ops.drainReportOutbox(workspaceId, orchestratorId)).toEqual({
      attempted: 1,
      firstSyncError: null,
    })
    await Promise.resolve()

    expect(deliverSystemMessageToAgent).toHaveBeenCalledWith(
      workspaceId,
      orchestratorId,
      expect.stringContaining('[Hive 系统消息：来自 @Alice 的汇报]'),
      { requireActiveRun: true }
    )
    expect(reportOutbox.pendingCount(workspaceId, orchestratorId)).toBe(0)
    db.close()
  })
})
