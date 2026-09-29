import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, test } from 'vitest'

import { normalizePtyText, writeNodeCli } from '../helpers/platform-cli.js'
import { startAuthorizedTestServer as startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

type TestServer = Awaited<ReturnType<typeof startTestServer>>
const servers = new Set<TestServer>()
const tempDirs: string[] = []

const openServer = async (dataDir: string) => {
  const server = await startTestServer({ dataDir })
  servers.add(server)
  return server
}

const closeServer = async (server: TestServer) => {
  await server.close()
  servers.delete(server)
}

afterEach(async () => {
  for (const server of servers) await closeServer(server)
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 })
  }
})

const createFixture = async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-shutdown-recovery-'))
  tempDirs.push(dataDir)
  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(workspacePath)
  const command = writeNodeCli(
    dataDir,
    'shutdown-agent',
    `process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  if (chunk.includes('finish')) process.exit(0)
})
process.stdout.write('READY\\n')
setInterval(() => {}, 1000)
`
  )
  const server = await openServer(dataDir)
  const workspace = server.store.createWorkspace(workspacePath, 'Shutdown recovery')
  const worker = server.store.addWorker(workspace.id, { name: 'Active', role: 'coder' })
  server.store.configureAgentLaunch(workspace.id, worker.id, { command })
  return { command, dataDir, server, worker, workspace }
}

const startViaHttp = async (server: TestServer, workspaceId: string, agentId: string) => {
  const cookie = await getUiCookie(server.baseUrl)
  const response = await fetch(
    `${server.baseUrl}/api/workspaces/${workspaceId}/agents/${agentId}/start`,
    { method: 'POST', headers: { cookie } }
  )
  expect(response.status).toBe(201)
  const payload = (await response.json()) as { run_id: string }
  await expectReady(server, payload.run_id)
  return payload.run_id
}

const expectReady = async (server: TestServer, runId: string) => {
  const cookie = await getUiCookie(server.baseUrl)
  await expect
    .poll(
      async () => {
        const response = await fetch(`${server.baseUrl}/api/runtime/runs/${runId}`, {
          headers: { cookie },
        })
        expect(response.status).toBe(200)
        const run = (await response.json()) as { output: string; status: string }
        return { output: normalizePtyText(run.output), status: run.status }
      },
      // ConPTY waits about 3s for a terminal DA reply when this HTTP-only
      // fixture has no attached terminal. Include that native wait.
      { interval: 25, timeout: 5000 }
    )
    .toEqual({ output: expect.stringContaining('READY'), status: 'running' })
}

test('resumes the active PTY after server close and reopening the same SQLite database', async () => {
  const { dataDir, server, worker, workspace } = await createFixture()
  const firstRunId = await startViaHttp(server, workspace.id, worker.id)

  await closeServer(server)
  const reopened = await openServer(dataDir)
  expect(reopened.store.listWorkers(workspace.id)).toContainEqual(
    expect.objectContaining({ id: worker.id, status: 'stopped' })
  )
  expect(reopened.store.listAgentRuns(worker.id)).toEqual([
    expect.objectContaining({ runId: firstRunId, endedAt: expect.any(Number) }),
  ])

  const results = await reopened.store.autoResumeInterruptedAgents({
    hivePort: new URL(reopened.baseUrl).port,
  })
  expect(results).toEqual([
    expect.objectContaining({ agentId: worker.id, ok: true, workspaceId: workspace.id }),
  ])
  const resumedRunId = results[0]?.runId
  expect(resumedRunId).toBeTruthy()
  expect(resumedRunId).not.toBe(firstRunId)
  await expectReady(reopened, resumedRunId ?? '')
})

test.each([
  'manual',
  'automatic',
] as const)('consumes shutdown recovery after a successful %s restart that then completes', async (restart) => {
  const { dataDir, server, worker, workspace } = await createFixture()
  await startViaHttp(server, workspace.id, worker.id)
  await closeServer(server)

  const reopened = await openServer(dataDir)
  const runId =
    restart === 'manual'
      ? await startViaHttp(reopened, workspace.id, worker.id)
      : (
          await reopened.store.autoResumeInterruptedAgents({
            hivePort: new URL(reopened.baseUrl).port,
          })
        )[0]?.runId
  expect(runId).toBeTruthy()
  await expectReady(reopened, runId ?? '')
  reopened.store.writeRunInput(runId ?? '', 'finish\r')
  await expect
    .poll(() => reopened.store.getLiveRun(runId ?? '').status, { interval: 25, timeout: 3000 })
    .toBe('exited')
  await expect(
    reopened.store.autoResumeInterruptedAgents({ hivePort: new URL(reopened.baseUrl).port })
  ).resolves.toEqual([])
  await closeServer(reopened)

  const third = await openServer(dataDir)
  expect(third.store.listWorkers(workspace.id)).toContainEqual(
    expect.objectContaining({ id: worker.id, status: 'stopped' })
  )
  await expect(
    third.store.autoResumeInterruptedAgents({ hivePort: new URL(third.baseUrl).port })
  ).resolves.toEqual([])
  expect(third.store.listAgentRuns(worker.id)).toHaveLength(2)
})

test('shutdown recovers only active members, leaving stopped, completed and unstarted members stopped', async () => {
  const { command, dataDir, server, worker, workspace } = await createFixture()
  const stopped = server.store.addWorker(workspace.id, { name: 'Stopped', role: 'coder' })
  const completed = server.store.addWorker(workspace.id, { name: 'Completed', role: 'coder' })
  const unstarted = server.store.addWorker(workspace.id, { name: 'Unstarted', role: 'coder' })
  for (const member of [stopped, completed, unstarted]) {
    server.store.configureAgentLaunch(workspace.id, member.id, { command })
  }
  const [, stoppedRunId, completedRunId] = await Promise.all([
    startViaHttp(server, workspace.id, worker.id),
    startViaHttp(server, workspace.id, stopped.id),
    startViaHttp(server, workspace.id, completed.id),
  ])
  const cookie = await getUiCookie(server.baseUrl)
  const stopResponse = await fetch(`${server.baseUrl}/api/runtime/runs/${stoppedRunId}/stop`, {
    headers: { cookie },
    method: 'POST',
  })
  expect(stopResponse.status).toBe(202)
  server.store.writeRunInput(completedRunId, 'finish\r')
  // Stop is accepted asynchronously; both members must have exited before
  // this scenario shuts down the one remaining active member.
  await expect
    .poll(
      () => [
        server.store.getLiveRun(stoppedRunId).status,
        server.store.getLiveRun(completedRunId).status,
      ],
      { interval: 25, timeout: 3000 }
    )
    .toEqual(['exited', 'exited'])
  await closeServer(server)

  const reopened = await openServer(dataDir)
  expect(reopened.store.listWorkers(workspace.id)).toHaveLength(4)
  const results = await reopened.store.autoResumeInterruptedAgents({
    hivePort: new URL(reopened.baseUrl).port,
  })
  expect(results).toEqual([expect.objectContaining({ agentId: worker.id, ok: true })])
  expect(reopened.store.listAgentRuns(stopped.id)).toHaveLength(1)
  expect(reopened.store.listAgentRuns(completed.id)).toHaveLength(1)
  expect(reopened.store.listAgentRuns(unstarted.id)).toEqual([])
  for (const member of [stopped, completed, unstarted]) {
    expect(reopened.store.listWorkers(workspace.id)).toContainEqual(
      expect.objectContaining({ id: member.id, status: 'stopped' })
    )
  }
})

test('a disabled workspace keeps its checkpoint across reopen until recovery is enabled', async () => {
  const { dataDir, server, worker, workspace } = await createFixture()
  server.store.setAutoResumeOnRestart(workspace.id, false)
  await startViaHttp(server, workspace.id, worker.id)
  await closeServer(server)

  const disabled = await openServer(dataDir)
  await expect(
    disabled.store.autoResumeInterruptedAgents({ hivePort: new URL(disabled.baseUrl).port })
  ).resolves.toEqual([
    expect.objectContaining({
      agentId: worker.id,
      error: 'Workspace auto-resume is disabled.',
      ok: false,
    }),
  ])
  expect(disabled.store.listAgentRuns(worker.id)).toHaveLength(1)
  await closeServer(disabled)

  const enabled = await openServer(dataDir)
  enabled.store.setAutoResumeOnRestart(workspace.id, true)
  const results = await enabled.store.autoResumeInterruptedAgents({
    hivePort: new URL(enabled.baseUrl).port,
  })
  expect(results).toEqual([expect.objectContaining({ agentId: worker.id, ok: true })])
  await expectReady(enabled, results[0]?.runId ?? '')
})

test('a launch failure retains the shutdown checkpoint for the next platform restart', async () => {
  const { command, dataDir, server, worker, workspace } = await createFixture()
  const originalRunId = await startViaHttp(server, workspace.id, worker.id)
  await closeServer(server)

  const failing = await openServer(dataDir)
  failing.store.configureAgentLaunch(workspace.id, worker.id, {
    command: join(dataDir, 'missing-native-command'),
  })
  const results = await failing.store.autoResumeInterruptedAgents({
    hivePort: new URL(failing.baseUrl).port,
  })
  expect(results).toEqual([expect.objectContaining({ agentId: worker.id, ok: false, runId: null })])
  expect(failing.store.listAgentRuns(worker.id)).toEqual([
    expect.objectContaining({ runId: originalRunId }),
  ])
  failing.store.configureAgentLaunch(workspace.id, worker.id, { command })
  await closeServer(failing)

  const repaired = await openServer(dataDir)
  const recovered = await repaired.store.autoResumeInterruptedAgents({
    hivePort: new URL(repaired.baseUrl).port,
  })
  expect(recovered).toEqual([expect.objectContaining({ agentId: worker.id, ok: true })])
  await expectReady(repaired, recovered[0]?.runId ?? '')
})

test.each([
  'before-first-spawn',
  'between-candidates',
] as const)('shutdown drains automatic recovery %s and preserves the remaining checkpoint', async (phase) => {
  const { command, dataDir, server, worker, workspace } = await createFixture()
  const other = server.store.addWorker(workspace.id, { name: 'Other', role: 'coder' })
  server.store.configureAgentLaunch(workspace.id, other.id, { command })
  const [first, second] = [worker, other].sort((left, right) => left.id.localeCompare(right.id))
  if (!first || !second) throw new Error('Expected two recovery candidates')
  const originalRuns = await Promise.all(
    [first, second].map((member) => startViaHttp(server, workspace.id, member.id))
  )
  const dispatch = await server.store.dispatchTask(
    workspace.id,
    second.id,
    'Preserve this pending task across interrupted recovery'
  )
  await closeServer(server)

  const reopened = await openServer(dataDir)
  const pendingDispatch = reopened.store.getDispatch(workspace.id, dispatch.id)
  expect(pendingDispatch).toMatchObject({
    reportedAt: null,
    text: 'Preserve this pending task across interrupted recovery',
  })
  let recoverySettled = false
  const recovery = reopened.store
    .autoResumeInterruptedAgents({ hivePort: new URL(reopened.baseUrl).port })
    .finally(() => {
      recoverySettled = true
    })
  if (phase === 'between-candidates') {
    await expect
      .poll(() => reopened.store.getActiveRunByAgentId(workspace.id, first.id)?.status, {
        interval: 10,
        timeout: 5000,
      })
      .toBe('running')
  }

  await closeServer(reopened)
  const settledAtClose = recoverySettled
  // Drain even the failing implementation, so its late database access cannot
  // escape this test and interfere with a different runtime.
  const results = await recovery
  expect(settledAtClose).toBe(true)
  expect(results).toHaveLength(1)
  expect(results[0]).toMatchObject({ agentId: first.id })

  const again = await openServer(dataDir)
  expect(again.store.resources.getSnapshot().occupancy.global).toBe(0)
  expect(again.store.listAgentRuns(second.id)).toEqual([
    expect.objectContaining({ runId: originalRuns[1] }),
  ])
  expect(again.store.getWorker(workspace.id, second.id)).toMatchObject({
    pendingTaskCount: 1,
    status: 'stopped',
  })
  expect(again.store.getDispatch(workspace.id, dispatch.id)).toEqual(pendingDispatch)

  const resumed = await again.store.autoResumeInterruptedAgents({
    hivePort: new URL(again.baseUrl).port,
  })
  expect(resumed).toEqual(
    [first, second].map((member) => expect.objectContaining({ agentId: member.id, ok: true }))
  )
  await Promise.all(resumed.map((result) => expectReady(again, result.runId ?? '')))
  expect(again.store.getWorker(workspace.id, second.id)).toMatchObject({
    pendingTaskCount: 1,
    status: 'working',
  })
  await closeServer(again)
  const final = await openServer(dataDir)
  expect(final.store.resources.getSnapshot().occupancy.global).toBe(0)
})
