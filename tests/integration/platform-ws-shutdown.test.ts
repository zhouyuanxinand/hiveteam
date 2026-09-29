import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import WebSocket from 'ws'
import { createAgentManager } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import Database from '../../src/server/sqlite.js'
import { createAuthorizedTestRuntimeStore } from '../helpers/authorized-runtime.js'
import { listenOnFetchSafePort } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

test('platform shutdown closes terminal and tasks WebSockets before HTTP drain and preserves restart recovery', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-platform-ws-close-'))
  const store = createAuthorizedTestRuntimeStore({ dataDir, agentManager: createAgentManager() })
  const app = createApp({ store })
  const sockets: WebSocket[] = []
  try {
    const port = await listenOnFetchSafePort(app.server)
    const origin = `http://127.0.0.1:${port}`
    const cookie = await getUiCookie(origin)
    const workspace = store.createWorkspace(dataDir, 'Shutdown recovery')
    const agentId = `${workspace.id}:orchestrator`
    store.configureAgentLaunch(workspace.id, agentId, {
      command: process.execPath,
      args: [
        '-e',
        "process.stdout.write('ready'); process.stdin.resume(); setInterval(() => {}, 1000)",
      ],
    })
    const run = await store.startAgent(workspace.id, agentId, { hivePort: String(port) })
    for (const path of [
      `/ws/terminal/${run.runId}/io`,
      `/ws/terminal/${run.runId}/control`,
      `/ws/tasks/${workspace.id}`,
    ]) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { cookie } })
      sockets.push(socket)
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve)
        socket.once('error', reject)
      })
    }
    expect(sockets.every((socket) => socket.readyState === WebSocket.OPEN)).toBe(true)
    const pausedTasks = sockets[2]
    if (!pausedTasks) throw new Error('Expected tasks socket')
    // An unresponsive browser must not hold HTTP shutdown until its close-handshake timeout.
    pausedTasks.pause()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Active WebSockets blocked HTTP shutdown')),
        2000
      )
      app.server.close((error) => {
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      })
      app.closeConnections()
      app.closeConnections()
    })
    pausedTasks.resume()
    await expect
      .poll(() => sockets.every((socket) => socket.readyState === WebSocket.CLOSED), {
        timeout: 2000,
      })
      .toBe(true)
    expect(app.terminalMetrics()).toEqual([])
    expect(store.getLiveRun(run.runId).status).toBe('running')
    await store.close()
    const db = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
    try {
      expect(
        db.prepare('SELECT status,resume_on_restart FROM agent_runs WHERE run_id=?').get(run.runId)
      ).toEqual({ status: 'exited', resume_on_restart: 1 })
    } finally {
      db.close()
    }
  } finally {
    for (const socket of sockets) socket.terminate()
    app.closeConnections()
    await store.close()
    if (app.server.listening)
      await new Promise<void>((resolve) => app.server.close(() => resolve()))
    rmSync(dataDir, { force: true, recursive: true, maxRetries: 20, retryDelay: 100 })
  }
}, 30000)
