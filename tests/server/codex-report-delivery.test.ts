import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, test } from 'vitest'
import { createAgentManager } from '../../src/server/agent-manager.js'
import { createAgentSessionStore } from '../../src/server/agent-session-store.js'
import { deliverCodexReport } from '../../src/server/codex-report-delivery.js'
import { createReportOutboxStore } from '../../src/server/report-outbox-store.js'
import { createAuthorizedTestRuntimeStore as createRuntimeStore } from '../helpers/authorized-runtime.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const waitFor = async (check: () => boolean, timeout = 12_000) => {
  const end = Date.now() + timeout
  while (!check()) {
    if (Date.now() >= end) throw new Error('Timed out waiting for application state')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const setup = async (ignoredEnters = 1, display = 'collapsed', workerTarget = false) => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-codex-receipt-'))
  const workspacePath = join(dir, 'workspace')
  const sessions = join(dir, 'codex', 'sessions')
  mkdirSync(workspacePath)
  mkdirSync(sessions, { recursive: true })
  const sessionId = randomUUID()
  const journal = join(sessions, `rollout-test-${sessionId}.jsonl`)
  const manager = createAgentManager()
  const store = createRuntimeStore({ agentManager: manager, dataDir: dir })
  const db = new Database(join(dir, 'runtime.sqlite'))
  cleanups.push(async () => {
    await store.close()
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const workspace = store.createWorkspace(workspacePath, 'Receipt regression')
  const orchestratorId = `${workspace.id}:orchestrator`
  const worker = store.addWorker(workspace.id, { name: 'Reviewer', role: 'reviewer' })
  const target = workerTarget ? worker.id : orchestratorId
  store.configureAgentLaunch(workspace.id, target, {
    command: process.execPath,
    args: [
      resolve('tests/fixtures/codex-report-tui.mjs'),
      journal,
      sessionId,
      '1600',
      String(ignoredEnters),
      display,
    ],
    interactiveCommand: 'codex',
    sessionIdCapture: { source: 'codex_session_jsonl_dir', pattern: `${sessions}/**/*.jsonl` },
  })
  const runId = (await store.startAgent(workspace.id, target, { hivePort: '4010' })).runId
  const currentRunId = runId
  await waitFor(() =>
    Boolean(db.prepare('SELECT 1 FROM agent_sessions WHERE agent_id = ?').get(target))
  )
  await waitFor(() =>
    manager
      .getRun(currentRunId)
      .output.includes(workerTarget ? 'Ask Codex to do anything' : 'APPLICATION_ACCEPTED')
  )
  return {
    db,
    dir,
    journal,
    manager,
    orchestratorId,
    runId: currentRunId,
    store,
    worker,
    workspace,
  }
}

test.each([
  'collapsed',
  'expanded',
])('a slow %s Codex paste and an ignored Enter cannot falsely acknowledge a worker report', async (display) => {
  const { db, journal, manager, runId, store, worker, workspace } = await setup(1, display)
  await store.dispatchTask(workspace.id, worker.id, 'Review the document')
  store.reportTask(workspace.id, worker.id, {
    requireActiveRun: true,
    text: 'Document reviewed. '.repeat(100),
  })
  const entry = () =>
    db.prepare('SELECT delivered_at FROM report_outbox').get() as { delivered_at: number | null }
  await waitFor(() => entry().delivered_at !== null)
  expect(readFileSync(journal, 'utf8')).toContain('Document reviewed.')
  expect(manager.getRun(runId).output).toContain('APPLICATION_ACCEPTED')
  expect(manager.getRun(runId).output).not.toContain('PASTES=2')
}, 20_000)

test('simultaneous worker reports reach distinct user messages exactly once', async () => {
  const { db, journal, manager, runId, store, worker, workspace } = await setup()
  const other = store.addWorker(workspace.id, { name: 'Tester', role: 'tester' })
  for (const member of [worker, other]) {
    await store.dispatchTask(workspace.id, member.id, 'Review the document')
    store.reportTask(workspace.id, member.id, {
      requireActiveRun: true,
      text: `Document reviewed. ${member.name}`,
    })
  }
  // Repeated polling during the first paste must not overlap writes; once it
  // is confirmed, the second report must drain without another browser poll.
  for (let index = 0; index < 5; index += 1) store.listWorkers(workspace.id)
  await waitFor(
    () =>
      (
        db
          .prepare('SELECT COUNT(*) AS n FROM report_outbox WHERE delivered_at IS NOT NULL')
          .get() as { n: number }
      ).n === 2
  )
  const reports = readFileSync(journal, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((record) => record.payload?.content?.[0]?.text?.includes('Document reviewed.'))
  expect(reports).toHaveLength(2)
  expect(reports[0].payload.content[0].text).toContain('Reviewer')
  expect(reports[0].payload.content[0].text).not.toContain('Document reviewed. Tester')
  expect(reports[1].payload.content[0].text).toContain('Tester')
  expect(manager.getRun(runId).output).not.toContain('PASTES=3')
}, 20_000)

test('focus notifications do not block submission, but user edits stop automatic Enter', async () => {
  const { manager, orchestratorId, runId, store, worker, workspace, db } = await setup(100)
  const initialSequence = manager.getInputSequence(runId)
  manager.writeInput(runId, '\x1b[I\x1b[O\x1b[1;1R')
  expect(manager.getInputSequence(runId)).toBe(initialSequence)
  await store.dispatchTask(workspace.id, worker.id, 'Review the document')
  store.reportTask(workspace.id, worker.id, { requireActiveRun: true, text: 'Document reviewed.' })
  await waitFor(() => manager.getRun(runId).output.includes('PASTES=1'))
  manager.writeInput(runId, 'user draft')
  const afterEdit = manager.getInputSequence(runId)
  const outbox = createReportOutboxStore(db)
  await waitFor(() =>
    Boolean(outbox.listPending(workspace.id, orchestratorId)[0]?.lastDeliveryError)
  )
  expect(outbox.listPending(workspace.id, orchestratorId)[0]).toMatchObject({
    deliveredAt: null,
    checkpoint: { submitAttempts: 0 },
    lastDeliveryError: expect.stringContaining('your draft'),
  })
  expect(manager.getInputSequence(runId)).toBe(afterEdit)
}, 20_000)

test('a native confirmation over the pasted report is never automatically approved', async () => {
  const { db, orchestratorId, manager, runId, store, worker, workspace } = await setup(0, 'blocked')
  await store.dispatchTask(workspace.id, worker.id, 'Review the document')
  store.reportTask(workspace.id, worker.id, { requireActiveRun: true, text: 'Document reviewed.' })
  const outbox = createReportOutboxStore(db)
  await waitFor(() =>
    Boolean(outbox.listPending(workspace.id, orchestratorId)[0]?.lastDeliveryError)
  )
  expect(outbox.listPending(workspace.id, orchestratorId)[0]).toMatchObject({
    deliveredAt: null,
    checkpoint: { submitAttempts: 0 },
    lastDeliveryError: expect.stringContaining('will not automatically confirm'),
  })
  expect(manager.getRun(runId).output).not.toContain('PASTES=2')
}, 20_000)

test('a persisted acceptance receipt repairs an interrupted acknowledgement without sending input again', async () => {
  const { db, manager, orchestratorId, runId, store, worker, workspace } = await setup()
  await store.dispatchTask(workspace.id, worker.id, 'Review the document')
  store.reportTask(workspace.id, worker.id, { requireActiveRun: true, text: 'Document reviewed.' })
  await waitFor(() =>
    Boolean(
      (
        db.prepare('SELECT delivered_at FROM report_outbox').get() as {
          delivered_at: number | null
        }
      ).delivered_at
    )
  )
  // Simulate a crash after the application accepted input but before SQLite
  // recorded the acknowledgement. Recreate the durable queue reader.
  db.prepare('UPDATE report_outbox SET delivered_at = NULL').run()
  const outbox = createReportOutboxStore(db)
  const entry = outbox.listPending(workspace.id, orchestratorId)[0]
  if (!entry?.checkpoint) throw new Error('Expected a durable paste checkpoint')
  const before = manager.getInputSequence(runId)
  await deliverCodexReport({
    agentManager: manager,
    agentId: orchestratorId,
    workspaceId: workspace.id,
    runId,
    text: entry.payload,
    sessions: createAgentSessionStore(db),
    receipt: {
      id: entry.receiptId,
      checkpoint: { ...entry.checkpoint, runId: 'previous-runtime-run' },
      save: (checkpoint) => outbox.saveCheckpoint(entry.id, entry.receiptId, checkpoint),
    },
  })
  outbox.markDelivered(entry.id)
  expect(outbox.pendingCount(workspace.id, orchestratorId)).toBe(0)
  expect(manager.getInputSequence(runId)).toBe(before)
}, 20_000)

test('a terminal with no acceptance keeps its report and diagnostic durable instead of reporting success', async () => {
  const { db, manager, orchestratorId, runId, store, worker, workspace } = await setup(100)
  await store.dispatchTask(workspace.id, worker.id, 'Review the document')
  store.reportTask(workspace.id, worker.id, { requireActiveRun: true, text: 'Document reviewed.' })
  const outbox = createReportOutboxStore(db)
  await waitFor(
    () => Boolean(outbox.listPending(workspace.id, orchestratorId)[0]?.lastDeliveryError),
    18_000
  )
  const entry = outbox.listPending(workspace.id, orchestratorId)[0]
  expect(entry).toMatchObject({
    deliveredAt: null,
    checkpoint: { pasteConfirmed: true, submitAttempts: 3 },
  })
  expect(entry?.lastDeliveryError).toContain('not confirmed')
  const before = manager.getInputSequence(runId)
  if (!entry?.checkpoint) throw new Error('Expected a durable paste checkpoint')
  await expect(
    deliverCodexReport({
      agentManager: manager,
      agentId: orchestratorId,
      workspaceId: workspace.id,
      runId,
      text: entry.payload,
      sessions: createAgentSessionStore(db),
      receipt: {
        id: entry.receiptId,
        checkpoint: { ...entry.checkpoint, runId: 'previous-runtime-run' },
        save: (checkpoint) => outbox.saveCheckpoint(entry.id, entry.receiptId, checkpoint),
      },
    })
  ).rejects.toThrow('previous terminal ended')
  expect(manager.getInputSequence(runId)).toBe(before)
  expect(manager.getRun(runId).output).not.toContain('PASTES=2')
}, 25_000)

test('dispatches share native receipt delivery and recover the journal acknowledgement after database reopen without new PTY input', async () => {
  const f = await setup(1, 'collapsed', true)
  const first = await f.store.dispatchTask(f.workspace.id, f.worker.id, 'NATIVE_DISPATCH_FIRST')
  const second = await f.store.dispatchTask(f.workspace.id, f.worker.id, 'NATIVE_DISPATCH_SECOND')
  await waitFor(() => f.store.dispatchDelivery.records.get(second.id)?.state === 'confirmed')
  expect(f.store.dispatchDelivery.records.get(first.id)).toMatchObject({
    state: 'confirmed',
    evidence: 'native_receipt',
    attempt: 1,
  })
  expect(f.store.dispatchDelivery.health.get(first.id)?.start_source).toBe('native_receipt')
  const messages = readFileSync(f.journal, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((record) => record.payload?.role === 'user')
    .map((record) => record.payload.content[0].text)
  expect(messages.filter((text) => text.includes('NATIVE_DISPATCH_FIRST'))).toHaveLength(1)
  expect(messages.filter((text) => text.includes('NATIVE_DISPATCH_SECOND'))).toHaveLength(1)
  // Crash window: native acceptance is durable, but the SQLite attempt has no acknowledgement.
  await f.store.close()
  f.db
    .prepare(
      "UPDATE message_deliveries SET state='attempting',evidence='none',confirmed_at=NULL WHERE id=?"
    )
    .run(first.id)
  const journalBefore = readFileSync(f.journal, 'utf8')
  const recovered = createRuntimeStore({ agentManager: createAgentManager(), dataDir: f.dir })
  try {
    await waitFor(() => recovered.dispatchDelivery.records.get(first.id)?.state === 'confirmed')
    expect(recovered.dispatchDelivery.records.get(first.id)).toMatchObject({
      attempt: 1,
      evidence: 'native_receipt',
    })
    expect(readFileSync(f.journal, 'utf8')).toBe(journalBefore)
    expect(recovered.listWorkers(f.workspace.id)[0]?.pendingTaskCount).toBe(2)
  } finally {
    await recovered.close()
  }
}, 30_000)
