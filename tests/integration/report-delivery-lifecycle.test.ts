import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createDispatchLedgerStore } from '../../src/server/dispatch-ledger-store.js'
import { createMessageDeliveryStore } from '../../src/server/message-delivery-store.js'
import { createReportOutboxStore } from '../../src/server/report-outbox-store.js'
import Database from '../../src/server/sqlite.js'
import { startAuthorizedTestServer, type TestServerContext } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers = new Set<TestServerContext>()
const directories: string[] = []
const open = async (dataDir: string) => {
  const server = await startAuthorizedTestServer({ dataDir })
  servers.add(server)
  return server
}
const close = async (server: TestServerContext) => {
  await server.close()
  servers.delete(server)
}
afterEach(async () => {
  for (const server of servers) await close(server)
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
const setup = async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hive-report-lifecycle-'))
  directories.push(directory)
  return open(directory)
}
const workspace = (server: TestServerContext, name: string) => {
  const path = join(server.dataDir, name)
  mkdirSync(path)
  const current = server.store.createWorkspace(path, name)
  const worker = server.store.addWorker(current.id, { name: 'Coder', role: 'coder' })
  const marker = join(path, 'received.txt')
  const script = join(path, 'echo.cjs')
  writeFileSync(marker, '')
  writeFileSync(
    script,
    `const fs=require('node:fs');process.stdin.setEncoding('utf8');process.stdin.on('data',text=>fs.appendFileSync(${JSON.stringify(marker)},text));console.log('REPORT_READY');process.stdin.resume()`
  )
  server.store.configureAgentLaunch(current.id, `${current.id}:orchestrator`, {
    command: process.execPath,
    args: [script],
  })
  return { id: current.id, worker, marker }
}
const start = async (server: TestServerContext, workspaceId: string) => {
  const response = await fetch(
    `${server.baseUrl}/api/workspaces/${workspaceId}/agents/${workspaceId}:orchestrator/start`,
    { method: 'POST', headers: { cookie: await getUiCookie(server.baseUrl) } }
  )
  expect(response.status).toBe(201)
  const { run_id } = (await response.json()) as { run_id: string }
  await expect
    .poll(() => server.store.getLiveRun(run_id).output, { timeout: 10_000 })
    .toContain('REPORT_READY')
}
const report = async (
  server: TestServerContext,
  target: ReturnType<typeof workspace>,
  text: string
) => {
  const dispatch = await server.store.dispatchTask(target.id, target.worker.id, 'Complete work')
  server.store.reportTask(target.id, target.worker.id, {
    dispatchId: dispatch.id,
    text,
    outcome: 'success',
    requireActiveRun: true,
  })
  const receipt = server.store.dispatchDelivery.records
    .list(target.id)
    .find((record) => record.dispatch_id === dispatch.id && record.kind === 'report')
  if (!receipt) throw new Error('Expected the report to be persisted')
  return receipt
}

test('a live recipient with more than one batch of blocked reports cannot starve another workspace', async () => {
  const server = await setup()
  const blocked = workspace(server, 'Blocked workspace')
  const independent = workspace(server, '独立 工作区')
  await start(server, blocked.id)
  const db = new Database(join(server.dataDir, 'runtime.sqlite'))
  try {
    const ledger = createDispatchLedgerStore(db)
    const outbox = createReportOutboxStore(db)
    const records = createMessageDeliveryStore(db)
    db.transaction(() => {
      for (let index = 0; index < 206; index++) {
        const dispatch = ledger.createDispatch({
          workspaceId: blocked.id,
          toAgentId: blocked.worker.id,
          text: `Blocked task ${index}`,
        })
        ledger.markReportedByWorker({
          workspaceId: blocked.id,
          toAgentId: blocked.worker.id,
          dispatchId: dispatch.id,
          reportText: `BLOCKED_REPORT_${index}`,
          artifacts: [],
        })
        records.confirm(dispatch.id, 'worker_ack')
        outbox.enqueue({
          workspaceId: blocked.id,
          targetAgentId: `${blocked.id}:orchestrator`,
          dispatchId: dispatch.id,
          payload: `BLOCKED_REPORT_${index}`,
        })
      }
      const first = outbox.listPending(blocked.id, `${blocked.id}:orchestrator`)[0]
      if (!first) throw new Error('Expected queued reports')
      expect(records.claim(first.receiptId, 'previous-run')?.attempt).toBe(1)
      records.failed(first.receiptId, 1, 'Requires composer review', 'manual')
    })()
  } finally {
    db.close()
  }

  const text = `INDEPENDENT_REPORT_${randomUUID()}`
  const receipt = await report(server, independent, text)
  await start(server, independent.id)
  await expect
    .poll(() => readFileSync(independent.marker, 'utf8'), { timeout: 5000 })
    .toContain(text)
  expect(server.store.dispatchDelivery.records.get(receipt.id)).toMatchObject({
    state: 'unknown',
    attempt: 1,
    evidence: 'pty_write',
  })
  expect(readFileSync(blocked.marker, 'utf8')).not.toContain('BLOCKED_REPORT_')
  expect(
    server.store.dispatchDelivery.records.list(blocked.id).filter((r) => r.kind === 'report')
  ).toHaveLength(206)
})

test('queued reports survive runtime reopen; subsequent restarts and team queries never repaste uncertain input', async () => {
  let server = await setup()
  const target = workspace(server, 'Report restart')
  const text = `PERSISTED_REPORT_${randomUUID()}`
  const receipt = await report(server, target, text)
  expect(receipt).toMatchObject({ state: 'pending', attempt: 0 })
  await close(server)
  server = await open(server.dataDir)
  await start(server, target.id)
  await expect.poll(() => readFileSync(target.marker, 'utf8'), { timeout: 5000 }).toContain(text)
  expect(server.store.dispatchDelivery.records.get(receipt.id)).toMatchObject({
    state: 'unknown',
    attempt: 1,
  })
  await close(server)
  server = await open(server.dataDir)
  await start(server, target.id)

  const cookie = await getUiCookie(server.baseUrl)
  const agentId = `${target.id}:orchestrator`
  const token = server.store.peekAgentToken(agentId)
  if (!token) throw new Error('Expected a live Orchestrator token')
  for (let index = 0; index < 5; index++) {
    for (const [path, headers] of [
      [`/api/ui/workspaces/${target.id}/team`, { cookie }],
      [
        `/api/workspaces/${target.id}/team`,
        { 'x-hive-agent-id': agentId, 'x-hive-agent-token': token },
      ],
    ] as const) {
      const response = await fetch(server.baseUrl + path, { headers })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: target.worker.id, pending_task_count: 0 }),
        ])
      )
    }
  }
  // Recovery context may quote the historical result. Count actual report
  // notifications rather than treating that context as a second delivery.
  expect(
    readFileSync(target.marker, 'utf8').split('[Hive 系统消息：来自 @Coder 的汇报]')
  ).toHaveLength(2)
  expect(server.store.dispatchDelivery.records.get(receipt.id)).toMatchObject({
    state: 'unknown',
    attempt: 1,
    evidence: 'pty_write',
  })
  expect(server.store.getDispatch(target.id, receipt.dispatch_id)).toMatchObject({
    status: 'reported',
    reportOutcome: 'success',
  })
})

test('a rejected report transaction cannot start another queued report as a side effect', async () => {
  const server = await setup()
  const target = workspace(server, 'Atomic report')
  await start(server, target.id)
  const current = await server.store.dispatchTask(target.id, target.worker.id, 'Current work')
  const db = new Database(join(server.dataDir, 'runtime.sqlite'))
  try {
    const ledger = createDispatchLedgerStore(db)
    const records = createMessageDeliveryStore(db)
    const outbox = createReportOutboxStore(db)
    const previous = ledger.createDispatch({
      workspaceId: target.id,
      toAgentId: target.worker.id,
      text: 'Earlier completed work',
    })
    ledger.markReportedByWorker({
      workspaceId: target.id,
      toAgentId: target.worker.id,
      dispatchId: previous.id,
      reportText: 'Already queued result',
      artifacts: [],
    })
    records.confirm(previous.id, 'worker_ack')
    outbox.enqueue({
      workspaceId: target.id,
      targetAgentId: `${target.id}:orchestrator`,
      dispatchId: previous.id,
      payload: 'Already queued result',
    })
    db.exec(
      "CREATE TRIGGER reject_report BEFORE INSERT ON report_outbox BEGIN SELECT RAISE(ABORT,'outbox unavailable'); END"
    )
    expect(() =>
      server.store.reportTask(target.id, target.worker.id, {
        dispatchId: current.id,
        text: 'New result',
        requireActiveRun: true,
      })
    ).toThrow('outbox unavailable')
    const pending = outbox.listPending(target.id, `${target.id}:orchestrator`)
    expect(pending).toHaveLength(1)
    expect(records.get(pending[0]?.receiptId ?? '')).toMatchObject({ state: 'pending', attempt: 0 })
    expect(server.store.getDispatch(target.id, current.id)?.status).toBe('queued')
    expect(server.store.listWorkers(target.id)[0]?.pendingTaskCount).toBe(1)
  } finally {
    db.exec('DROP TRIGGER IF EXISTS reject_report')
    db.close()
  }
})
