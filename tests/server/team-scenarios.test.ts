import { afterEach, describe, expect, test } from 'vitest'

import { WORKER_NAME_POOL } from '../../src/shared/random-worker-name.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
})

const createPreset = (server: Awaited<ReturnType<typeof startTestServer>>, command: string) =>
  server.store.settings.createCommandPreset({
    args: [],
    command,
    displayName: 'Scenario CLI',
    env: {},
    resumeArgsTemplate: null,
    sessionIdCapture: null,
    yoloArgsTemplate: null,
  })

describe('team scenario routes', () => {
  test('creates the preset team and binds every member to the selected CLI', async () => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const workspace = server.store.createWorkspace(server.dataDir, 'Scenario')
    const preset = createPreset(server, process.execPath)

    const response = await fetch(
      `${server.baseUrl}/api/ui/workspaces/${workspace.id}/team-scenarios/ship-feature`,
      {
        body: JSON.stringify({ autostart: false, command_preset_id: preset.id }),
        headers: { 'content-type': 'application/json', cookie },
        method: 'POST',
      }
    )
    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      created: string[]
      started: unknown[]
      workers: Array<{ command_preset_id: string | null; name: string }>
    }
    expect(body.created).toHaveLength(3)
    expect(body.started).toEqual([])
    expect(body.workers).toHaveLength(3)
    expect(new Set(body.workers.map((worker) => worker.name)).size).toBe(3)
    for (const worker of body.workers) {
      expect(worker.command_preset_id).toBe(preset.id)
      expect(WORKER_NAME_POOL).toContain(worker.name)
    }
  })

  test('returns an install guide instead of starting a missing CLI', async () => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const workspace = server.store.createWorkspace(server.dataDir, 'Missing scenario CLI')
    const preset = createPreset(server, 'hive-scenario-cli-that-is-not-installed')

    const response = await fetch(
      `${server.baseUrl}/api/ui/workspaces/${workspace.id}/team-scenarios/fix-a-bug`,
      {
        body: JSON.stringify({ command_preset_id: preset.id }),
        headers: { 'content-type': 'application/json', cookie },
        method: 'POST',
      }
    )
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: expect.stringContaining('not available on PATH'),
      missing: [
        expect.objectContaining({
          display_name: 'Scenario CLI',
          id: preset.id,
          install_hint: expect.stringContaining('Install the standalone Scenario CLI'),
        }),
      ],
    })
    expect(server.store.listWorkers(workspace.id)).toEqual([])
  })
})
