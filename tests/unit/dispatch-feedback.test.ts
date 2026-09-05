import '../helpers/mock-node-pty.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'
import { createAgentManager } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const servers: Array<{ close: () => Promise<void> }> = []
const stores: Array<{ close: () => Promise<void> }> = []

const waitFor = async (assertion: () => void, timeoutMs = 1500, intervalMs = 20) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() <= deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  throw lastError
}

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
  while (stores.length > 0) await stores.pop()?.close()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

const startServerWithTeam = async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-dispatch-feedback-'))
  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  tempDirs.push(dataDir)

  const workerScript = join(workspacePath, 'worker-echo.js')
  writeFileSync(
    workerScript,
    [
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', (chunk) => {",
      "  process.stdout.write('PROMPT:' + chunk)",
      '})',
    ].join('\n')
  )

  const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
  stores.push(store)
  const workspace = store.createWorkspace(workspacePath, 'Alpha')
  const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
  if (!orchestrator) throw new Error('Expected default orchestrator')

  const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
  store.configureAgentLaunch(workspace.id, worker.id, {
    command: process.execPath,
    args: [workerScript],
  })
  store.configureAgentLaunch(workspace.id, orchestrator.id, {
    command: process.execPath,
    args: ['-e', 'process.stdin.resume()'],
  })

  const app = createApp({ store })
  await new Promise<void>((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve())
  })
  servers.push({
    close: async () => {
      await store.close()
      await new Promise<void>((resolve) => app.server.close(() => resolve()))
    },
  })

  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('Server did not bind to a port')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    orchestrator,
    store,
    worker,
    workspace,
  }
}

const postFeedback = (
  baseUrl: string,
  workspaceId: string,
  dispatchId: string,
  body: unknown,
  cookie?: string
) =>
  fetch(`${baseUrl}/api/ui/workspaces/${workspaceId}/dispatches/${dispatchId}/feedback`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  })

describe('dispatch review feedback', () => {
  test('feedback on a reported dispatch reopens it and reaches the worker PTY', async () => {
    const { baseUrl, orchestrator, store, worker, workspace } = await startServerWithTeam()
    await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })
    await store.startAgent(workspace.id, orchestrator.id, { hivePort: '4010' })

    const dispatch = await store.dispatchTask(workspace.id, worker.id, '实现登录', {
      fromAgentId: orchestrator.id,
    })
    await store.reportTask(workspace.id, worker.id, {
      dispatchId: dispatch.id,
      status: 'success',
      text: '登录已完成',
    })
    expect(store.getDispatch(workspace.id, dispatch.id)?.status).toBe('reported')
    expect(
      store.listWorkers(workspace.id).find((item) => item.id === worker.id)?.pendingTaskCount
    ).toBe(0)

    const cookie = await getUiCookie(baseUrl)
    const response = await postFeedback(
      baseUrl,
      workspace.id,
      dispatch.id,
      {
        text: '请把按钮换成红色并补一个测试',
      },
      cookie
    )
    expect(response.status).toBe(202)
    const body = (await response.json()) as { id: string; state: string }
    expect(body).toEqual(expect.objectContaining({ id: dispatch.id, state: 'submitted' }))

    // The dispatch is open again, the pending count is restored, and the
    // feedback text was pasted into the worker PTY.
    expect(store.getDispatch(workspace.id, dispatch.id)?.status).toBe('submitted')
    expect(
      store.listWorkers(workspace.id).find((item) => item.id === worker.id)?.pendingTaskCount
    ).toBe(1)
    await waitFor(() => {
      const run = store.getActiveRunByAgentId(workspace.id, worker.id)
      expect(run?.output).toContain('请把按钮换成红色并补一个测试')
    })
    expect(store.listMessagesForRecovery(workspace.id, 0)).toContainEqual(
      expect.objectContaining({
        text: '请把按钮换成红色并补一个测试',
        to: worker.id,
        type: 'feedback',
      })
    )
  })

  test('feedback requires an active worker run and rejects invalid input', async () => {
    const { baseUrl, store, worker, workspace } = await startServerWithTeam()
    // No fromAgentId: dispatchTask stays queued and does not auto-start the
    // worker, so there is no active run to receive feedback.
    const dispatch = await store.dispatchTask(workspace.id, worker.id, '实现登录')
    const cookie = await getUiCookie(baseUrl)

    const unauthenticated = await postFeedback(baseUrl, workspace.id, dispatch.id, {
      text: 'hello',
    })
    expect(unauthenticated.status).toBe(403)

    const empty = await postFeedback(baseUrl, workspace.id, dispatch.id, { text: '  ' }, cookie)
    expect(empty.status).toBe(400)

    const missing = await postFeedback(
      baseUrl,
      workspace.id,
      'missing-dispatch',
      {
        text: 'hello',
      },
      cookie
    )
    expect(missing.status).toBe(404)

    // The worker was never started, so feedback cannot be delivered.
    const inactive = await postFeedback(
      baseUrl,
      workspace.id,
      dispatch.id,
      {
        text: '请继续完善',
      },
      cookie
    )
    expect(inactive.status).toBe(409)
    expect(((await inactive.json()) as { error: string }).error).toContain('not running')
  })

  test('feedback on a cancelled dispatch is rejected', async () => {
    const { baseUrl, orchestrator, store, worker, workspace } = await startServerWithTeam()
    await store.startAgent(workspace.id, worker.id, { hivePort: '4010' })

    const dispatch = await store.dispatchTask(workspace.id, worker.id, '实现登录', {
      fromAgentId: orchestrator.id,
    })
    store.cancelTask(workspace.id, dispatch.id, {
      fromAgentId: orchestrator.id,
      reason: '不需要了',
    })
    expect(store.getDispatch(workspace.id, dispatch.id)?.status).toBe('cancelled')

    const cookie = await getUiCookie(baseUrl)
    const response = await postFeedback(
      baseUrl,
      workspace.id,
      dispatch.id,
      {
        text: '改主意了，还是做一下',
      },
      cookie
    )
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: string }).error).toContain('cancelled')
  })
})
