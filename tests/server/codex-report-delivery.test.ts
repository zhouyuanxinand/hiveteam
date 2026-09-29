import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { createAgentManager } from '../../src/server/agent-manager.js'
import { createAgentSessionStore } from '../../src/server/agent-session-store.js'
import { codexMessageHash } from '../../src/server/codex-message-wire.js'
import { deliverCodexReport } from '../../src/server/codex-report-delivery.js'
import { createReportOutboxStore } from '../../src/server/report-outbox-store.js'
import Database from '../../src/server/sqlite.js'
import { createAuthorizedTestRuntimeStore as createRuntimeStore } from '../helpers/authorized-runtime.js'
import { writeCodexCli } from '../helpers/codex-cli.js'

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
  const binDir = join(dir, 'bin')
  mkdirSync(binDir)
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
    command: writeCodexCli(
      binDir,
      `await import(${JSON.stringify(pathToFileURL(resolve('tests/fixtures/codex-report-tui.mjs')).href)})`
    ),
    args: [journal, sessionId, '1600', String(ignoredEnters), display],
    interactiveCommand: 'codex',
    sessionIdCapture: { source: 'codex_session_jsonl_dir', pattern: `${sessions}/**/*.jsonl` },
  })
  const runId = (await store.startAgent(workspace.id, target, { hivePort: '4010' })).runId
  const currentRunId = runId
  if (display !== 'delayed-session')
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
    sessionId,
    manager,
    orchestratorId,
    runId: currentRunId,
    store,
    worker,
    workspace,
  }
}

test('the first worker dispatch creates and binds a session only after native acceptance', async () => {
  const f = await setup(1, 'delayed-session', true)
  expect(existsSync(f.journal)).toBe(false)
  const dispatch = await f.store.dispatchTask(f.workspace.id, f.worker.id, 'FIRST_SESSION_DISPATCH')
  await waitFor(
    () => f.store.dispatchDelivery.records.get(dispatch.id)?.state === 'confirmed',
    9000
  )
  expect(
    f.db.prepare('SELECT last_session_id FROM agent_sessions WHERE agent_id=?').get(f.worker.id)
  ).toEqual({ last_session_id: f.sessionId })
  expect(f.store.dispatchDelivery.records.get(dispatch.id)).toMatchObject({
    state: 'confirmed',
    evidence: 'native_receipt',
    session_id: f.sessionId,
    attempt: 1,
  })
  const journal = readFileSync(f.journal, 'utf8')
  expect(journal).toContain('FIRST_SESSION_DISPATCH')
  expect(journal).toContain(
    `Hive session binding: workspace_id=${f.workspace.id}; agent_id=${f.worker.id}`
  )
  expect(journal).toContain(`[Hive report receipt: ${dispatch.id}]`)
  expect(f.manager.getRun(f.runId).output).not.toContain('PASTES=2')
  const events = f.store.dispatchDelivery.records.events(dispatch.id) as Array<{ event: string }>
  expect(events.findIndex((event) => event.event === 'checkpoint')).toBeLessThan(
    events.findIndex((event) => event.event === 'write_started')
  )
}, 25_000)

test('an unbound first dispatch preserves a user edit and never pastes the uncertain task again', async () => {
  const f = await setup(100, 'delayed-session', true)
  const dispatch = await f.store.dispatchTask(f.workspace.id, f.worker.id, 'PRESERVE_FIRST_DRAFT')
  await waitFor(() => f.manager.getRun(f.runId).output.includes('PASTES=1'))
  const checkpoint = JSON.parse(
    f.store.dispatchDelivery.records.get(dispatch.id)?.checkpoint ?? '{}'
  )
  expect(checkpoint).toMatchObject({ sessionId: null, sessionFile: null, submitAttempts: 0 })
  f.manager.writeInput(f.runId, 'user draft')
  const sequence = f.manager.getInputSequence(f.runId)
  await waitFor(() => f.store.dispatchDelivery.records.get(dispatch.id)?.state === 'unknown')
  await new Promise((resolve) => setTimeout(resolve, 1500))
  expect(f.manager.getInputSequence(f.runId)).toBe(sequence)
  expect(existsSync(f.journal)).toBe(false)
  expect(f.manager.getRun(f.runId).output).not.toContain('PASTES=2')
  expect(f.store.getDispatch(f.workspace.id, dispatch.id)?.status).not.toBe('submitted')
}, 20_000)

test('an unbound checkpoint recovers its receipt after reopen without accepting another member session', async () => {
  const f = await setup(1, 'delayed-session', true)
  const dispatch = await f.store.dispatchTask(f.workspace.id, f.worker.id, 'RECOVER_FIRST_RECEIPT')
  await waitFor(() => f.store.dispatchDelivery.records.get(dispatch.id)?.state === 'confirmed')
  const record = f.store.dispatchDelivery.records.get(dispatch.id)
  const checkpoint = JSON.parse(record?.checkpoint ?? '{}')
  await f.store.close()
  f.db
    .prepare(
      "UPDATE message_deliveries SET state='attempting', evidence='none',confirmed_at=NULL,session_id=NULL,checkpoint=? WHERE id=?"
    )
    .run(
      JSON.stringify({ ...checkpoint, sessionId: null, sessionFile: null, offset: 0 }),
      dispatch.id
    )
  const otherSession = randomUUID()
  const otherFile = join(f.dir, 'codex', 'sessions', `rollout-other-${otherSession}.jsonl`)
  const unrelatedJournal =
    [
      { type: 'session_meta', payload: { id: otherSession, cwd: f.workspace.path } },
      {
        type: 'response_item',
        payload: {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `Hive session binding: workspace_id=${f.workspace.id}; agent_id=another-member\n[Hive report receipt: ${dispatch.id}]`,
            },
          ],
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n'
  writeFileSync(otherFile, unrelatedJournal)
  f.db
    .prepare('UPDATE agent_sessions SET last_session_id=? WHERE agent_id=?')
    .run(otherSession, f.worker.id)
  const journalBefore = readFileSync(f.journal, 'utf8')
  const recovered = createRuntimeStore({ agentManager: createAgentManager(), dataDir: f.dir })
  try {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(recovered.dispatchDelivery.records.get(dispatch.id)?.state).toBe('unknown')
    // A captured conversation carrying the right binding but no receipt must
    // not poison the reader cache when capture later resolves another ID.
    const bindingOnlyJournal = unrelatedJournal
      .replace('agent_id=another-member', `agent_id=${f.worker.id}`)
      .replace(`[Hive report receipt: ${dispatch.id}]`, 'No delivery receipt in this session')
    writeFileSync(otherFile, bindingOnlyJournal)
    expect(recovered.dispatchDelivery.recheck(dispatch.id)).toBe(false)
    f.db
      .prepare('UPDATE agent_sessions SET last_session_id=? WHERE agent_id=?')
      .run(f.sessionId, f.worker.id)
    await waitFor(() => recovered.dispatchDelivery.records.get(dispatch.id)?.state === 'confirmed')
    expect(recovered.dispatchDelivery.records.get(dispatch.id)).toMatchObject({
      evidence: 'native_receipt',
      session_id: f.sessionId,
      attempt: 1,
    })
    expect(readFileSync(f.journal, 'utf8')).toBe(journalBefore)
    expect(readFileSync(otherFile, 'utf8')).toBe(bindingOnlyJournal)
  } finally {
    await recovered.close()
  }
}, 30_000)

test.each([
  'collapsed',
  'mixed',
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
  const report = readFileSync(journal, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((record) => record.payload?.content?.[0]?.text?.includes('Document reviewed.'))
  const text = report.payload.content[0].text as string
  expect(text).toContain('[Hive report receipt:')
  expect(
    db
      .prepare(`SELECT utf8_bytes FROM delivery_payload_measurements p
    JOIN message_deliveries m ON m.id=p.delivery_id WHERE m.kind='report'`)
      .all()
  ).toEqual([{ utf8_bytes: Buffer.byteLength(text, 'utf8') }])
}, 20_000)

test.skipIf(process.platform !== 'win32')(
  'the complete Windows wire is preserved and its matching marker cannot hide corrupted text',
  async () => {
    const f = await setup(0, 'corrupt-receipt', true)
    const dispatch = await f.store.dispatchTask(
      f.workspace.id,
      f.worker.id,
      'UNCHANGED 中文\n  second line 🐝'
    )
    await waitFor(() => f.manager.getRun(f.runId).output.includes('APPLICATION_ACCEPTED'))
    await waitFor(
      () => f.store.dispatchDelivery.records.get(dispatch.id)?.state === 'unknown',
      18_000
    )
    const record = f.store.dispatchDelivery.records.get(dispatch.id)
    const checkpoint = JSON.parse(record?.checkpoint ?? '{}')
    expect(checkpoint).toMatchObject({
      wireFormat: 'json-string-v1',
      wireSha256: expect.stringMatching(/^[a-f\d]{64}$/u),
    })
    const messages = readFileSync(f.journal, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((item) => item.type === 'response_item' && item.payload?.role === 'user')
      .map((item) => item.payload.content[0].text as string)
    const received = messages.find((text) => text.includes(`[Hive report receipt: ${dispatch.id}]`))
    expect(received).toContain('CHANGED 中文\\n  second line 🐝')
    expect(received).not.toContain('\n')
    expect(codexMessageHash(received ?? '')).not.toBe(checkpoint.wireSha256)
    expect(f.store.dispatchDelivery.recheck(dispatch.id)).toBe(false)
    expect(record?.evidence).toBe('none')
    expect(f.store.getDispatch(f.workspace.id, dispatch.id)?.status).toBe('failed')
    expect(f.manager.getRun(f.runId).output).not.toContain('PASTES=2')
  },
  25_000
)

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
  const { db, journal, manager, orchestratorId, runId, store, worker, workspace } = await setup(100)
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
  // Both the input guard and the Codex receipt loop have a 15-second deadline.
  // Either may expire first; neither is evidence of application acceptance.
  expect(entry?.lastDeliveryError).toMatch(
    /not confirmed receipt of the message|^Delivery confirmation deadline reached$/u
  )
  expect(readFileSync(journal, 'utf8')).not.toContain('Document reviewed.')
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
