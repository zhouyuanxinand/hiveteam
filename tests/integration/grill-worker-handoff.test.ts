import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { runTeamCommand } from '../../src/cli/team.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

let server: Awaited<ReturnType<typeof startTestServer>>
let directory: string
let workspaceId: string
let workerId: string
let cookie: string
const originalEnv = { ...process.env }

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'hive-grill-'))
  const workspacePath = join(directory, '中文 workspace')
  const sourcePath = join(directory, 'pack')
  mkdirSync(workspacePath)
  for (const name of ['grilling', 'tdd']) {
    const path = join(sourcePath, name)
    mkdirSync(path, { recursive: true })
    writeFileSync(
      join(path, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} test fixture\n---\nPINNED-${name}-BODY`
    )
  }
  server = await startTestServer({ dataDir: join(directory, 'runtime') })
  cookie = await getUiCookie(server.baseUrl)
  workspaceId = server.store.createWorkspace(workspacePath, 'Clarification').id
  workerId = server.store.addWorker(workspaceId, { name: 'Interviewer', role: 'coder' }).id
  const release = await server.store.skills.resolvePack({
    packName: 'matt',
    source: { type: 'local', path: sourcePath },
  })
  const plan = await server.store.skills.plan(workspaceId, {
    action: 'bind',
    packName: 'matt',
    releaseId: release.id,
    nativeExposure: [],
    profiles: { orchestrator: ['grilling', 'tdd'], coder: ['tdd'] },
  })
  await server.store.skills.applyPlan(workspaceId, plan.id)
})

afterEach(async () => {
  process.env = { ...originalEnv }
  vi.restoreAllMocks()
  await server.close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const start = async (agentId: string, label: string) => {
  const received = join(directory, `${label}.txt`)
  const script = join(directory, `${label}.mjs`)
  writeFileSync(received, '')
  writeFileSync(
    script,
    `import {appendFileSync} from 'node:fs';process.stdin.setEncoding('utf8');process.stdin.on('data', text=>{appendFileSync(${JSON.stringify(received)},text);process.stdout.write(text)});setInterval(()=>{},1000)`
  )
  server.store.configureAgentLaunch(workspaceId, agentId, {
    command: process.execPath,
    args: [script],
  })
  await server.store.startAgent(workspaceId, agentId, { hivePort: new URL(server.baseUrl).port })
  return () => readFileSync(received, 'utf8')
}
const post = (suffix: string, input: unknown) =>
  fetch(`${server.baseUrl}/api/workspaces/${workspaceId}/review${suffix}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
const agentEnv = (agentId: string) => {
  process.env = {
    ...originalEnv,
    HIVE_PORT: new URL(server.baseUrl).port,
    HIVE_PROJECT_ID: workspaceId,
    HIVE_AGENT_ID: agentId,
    HIVE_AGENT_TOKEN: server.store.peekAgentToken(agentId) ?? '',
  }
}

test('real CLI + HTTP + PTYs isolate the interview and deliver only the final handoff, including after restart', async () => {
  const orch = `${workspaceId}:orchestrator`
  const mainReceived = await start(orch, 'main')
  const memberReceived = await start(workerId, 'member')
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  agentEnv(orch)
  await expect(runTeamCommand(['skill', 'load', 'matt/grilling'])).rejects.toThrow('Delegate')
  await expect(runTeamCommand(['skill', 'load', ' matt/grilling '])).rejects.toThrow('Delegate')
  await runTeamCommand(['send', 'Interviewer', 'Clarify the mail plan', '--skill', 'matt/grilling'])
  const result = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { dispatch_id: string }
  expect(server.store.getDispatch(workspaceId, result.dispatch_id)?.status).toBe('submitted')
  await expect.poll(memberReceived).toContain('PINNED-grilling-BODY')
  expect(memberReceived()).toContain(`docs/clarifications/${result.dispatch_id}/final.md`)
  expect(mainReceived()).not.toContain('PINNED-grilling-BODY')
  const input = {
    request_id: randomUUID(),
    agent_id: workerId,
    text: 'PRIVATE-ANSWER\n自由编辑而不是选项',
    question: 'Q1',
  }
  expect((await post('/answer', input)).status).toBe(202)
  await expect.poll(memberReceived).toContain('PRIVATE-ANSWER')
  expect((await post('/answer', { ...input, agent_id: orch })).status).toBe(409)
  expect((await post('/answer', input)).status).toBe(202)
  agentEnv(workerId)
  await runTeamCommand(['status', 'PRIVATE-INTERMEDIATE-QUESTION'])
  agentEnv(orch)
  await runTeamCommand(['list'])
  const listed = JSON.parse(String(log.mock.calls.at(-1)?.[0]))
  expect(JSON.stringify(listed)).not.toContain('PRIVATE-')
  expect(server.store.listWorkers(workspaceId)[0]?.clarification).toMatchObject({
    dispatchId: result.dispatch_id,
    active: true,
  })
  expect(server.store.getLastPtyLineForAgent(workspaceId, workerId)).toBeNull()
  expect(JSON.stringify(server.store.listMessagesForRecovery(workspaceId, 0))).not.toContain(
    'PRIVATE-'
  )
  expect(
    (await post('/answer', { ...input, request_id: randomUUID(), text: 'MEMBER-FENCE' })).status
  ).toBe(202)
  await expect.poll(memberReceived).toContain('MEMBER-FENCE')
  expect(memberReceived().split(`[Hive user response ${input.request_id}]`)).toHaveLength(2)
  // Stop the main process: the final handoff must use the durable outbox.
  const mainRun = server.store.getActiveRunByAgentId(workspaceId, orch)
  if (!mainRun) throw new Error('Expected main PTY')
  server.store.stopAgentRun(mainRun.runId)
  await expect.poll(() => server.store.getActiveRunByAgentId(workspaceId, orch)).toBeUndefined()
  agentEnv(workerId)
  await runTeamCommand([
    'report',
    'FINAL-SCOPE: confirmed plan, constraints and acceptance criteria',
    '--dispatch',
    result.dispatch_id,
    '--outcome',
    'success',
  ])
  expect(server.store.getDispatch(workspaceId, result.dispatch_id)?.status).toBe('reported')
  expect(server.store.getWorker(workspaceId, workerId).pendingTaskCount).toBe(0)
  expect(mainReceived()).not.toContain('PRIVATE-')
  await server.close()
  server = await startTestServer({ dataDir: join(directory, 'runtime') })
  cookie = await getUiCookie(server.baseUrl)
  expect(JSON.stringify(server.store.listMessagesForRecovery(workspaceId, 0))).not.toContain(
    'PRIVATE-'
  )
  expect(server.store.listWorkers(workspaceId)[0]?.clarification?.active).toBe(false)
  const resumedMain = await start(orch, 'resumed-main')
  server.store.listWorkers(workspaceId)
  await expect.poll(resumedMain).toContain('FINAL-SCOPE')
  expect(resumedMain()).not.toContain('PRIVATE-')
  expect(resumedMain()).not.toContain('PINNED-grilling-BODY')
  const receipt = server.store.review.submission(workspaceId, input.request_id)
  expect(receipt).toMatchObject({ agent_id: workerId, status: 'submitted' })
  const db = new Database(join(directory, 'runtime/runtime.sqlite'), { readonly: true })
  try {
    expect(
      db.prepare("SELECT text, to_agent_id FROM messages WHERE type = 'status'").get()
    ).toMatchObject({ text: 'PRIVATE-INTERMEDIATE-QUESTION', to_agent_id: workerId })
  } finally {
    db.close()
  }
}, 30_000)

test('requires an idle member, serializes interview dispatches, and preserves ordinary profile restrictions', async () => {
  await start(workerId, 'idle-member')
  const dispatch = await server.store.dispatchTaskByWorkerName(
    workspaceId,
    'Interviewer',
    'Existing work'
  )
  await expect(
    server.store.dispatchTaskByWorkerName(workspaceId, 'Interviewer', 'Interview', {
      skillName: 'matt/grilling',
    })
  ).rejects.toThrow('idle member')
  server.store.cancelTask(workspaceId, dispatch.id, {
    fromAgentId: `${workspaceId}:orchestrator`,
    reason: 'Test transition',
  })
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      server.store.dispatchTaskByWorkerName(workspaceId, 'Interviewer', 'Interview', {
        skillName: 'matt/grilling',
      })
    )
  )
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  await expect(
    server.store.dispatchTaskByWorkerName(workspaceId, 'Interviewer', 'Do not interrupt')
  ).rejects.toThrow('conducting a clarification')
  await expect(
    server.store.skills.loadForAgent({ workspaceId, agentId: workerId, skillName: 'matt/tdd' })
  ).rejects.toThrow('own open dispatch')
  expect(server.store.listWorkers(workspaceId)[0]?.pendingTaskCount).toBe(1)
  const interview = server.store.listWorkers(workspaceId)[0]?.clarification
  if (!interview) throw new Error('Expected active clarification')
  server.store.sendDispatchFeedback(workspaceId, interview.dispatchId, 'PRIVATE-FEEDBACK')
  expect(JSON.stringify(server.store.listMessagesForRecovery(workspaceId, 0))).not.toContain(
    'PRIVATE-FEEDBACK'
  )
})

test('rejects cross-workspace recipients, preserves stopped-member replies without forwarding, and resumes normal status after new work', async () => {
  const otherPath = join(directory, 'other')
  mkdirSync(otherPath)
  const other = server.store.createWorkspace(otherPath, 'Other')
  const outsider = server.store.addWorker(other.id, { name: 'Other', role: 'coder' })
  const answer = { request_id: randomUUID(), agent_id: outsider.id, text: 'private', question: '' }
  expect((await post('/answer', answer)).status).toBe(404)
  expect((await post('/answer', { ...answer, agent_id: 123 })).status).toBe(400)
  const blocked = await (await post('/answer', { ...answer, agent_id: workerId })).json()
  expect(blocked).toMatchObject({ status: 'blocked', agent_id: workerId })
  expect(server.store.listTerminalRuns(workspaceId)).toHaveLength(0)
  await start(workerId, 'stopped-member-started')
  const interview = await server.store.dispatchTaskByWorkerName(
    workspaceId,
    'Interviewer',
    'Interview',
    { skillName: 'matt/grilling' }
  )
  server.store.reportTask(workspaceId, workerId, {
    dispatchId: interview.id,
    text: 'Final',
    outcome: 'success',
  })
  await server.store.dispatchTaskByWorkerName(workspaceId, 'Interviewer', 'Ordinary work')
  expect(() =>
    server.store.sendDispatchFeedback(workspaceId, interview.id, 'Do not reopen old interview')
  ).toThrow('moved to another task')
  expect(server.store.listWorkers(workspaceId)[0]?.clarification).toBeUndefined()
  server.store.statusTask(workspaceId, workerId, { text: 'NORMAL-STATUS' })
  expect(server.store.listMessagesForRecovery(workspaceId, 0)).toContainEqual(
    expect.objectContaining({ text: 'NORMAL-STATUS', type: 'status' })
  )
})
