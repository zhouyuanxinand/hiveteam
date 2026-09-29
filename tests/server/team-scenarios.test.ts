import { afterEach, describe, expect, test, vi } from 'vitest'

import type { ScenarioLaunchEvent } from '../../src/shared/team-scenario-launch.js'
import { startAuthorizedTestServer as startTestServer } from '../helpers/test-server.js'
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
  test('reports a post-header failure without a second HTTP response or losing the created members', async () => {
    const server = await startTestServer()
    servers.push(server)
    const workspace = server.store.createWorkspace(server.dataDir, 'Progress failure')
    const cookie = await getUiCookie(server.baseUrl)
    const preset = createPreset(server, process.execPath)
    const workers = server.store.listWorkers.bind(server.store)
    vi.spyOn(server.store, 'listWorkers').mockImplementationOnce(() => {
      throw new Error('Cannot read final worker snapshot')
    })
    const response = await fetch(
      `${server.baseUrl}/api/ui/workspaces/${workspace.id}/team-scenarios/ship-feature`,
      {
        method: 'POST',
        headers: { accept: 'application/x-ndjson', 'content-type': 'application/json', cookie },
        body: JSON.stringify({ autostart: false, command_preset_id: preset.id }),
      }
    )
    const events = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(response.status).toBe(201)
    expect(events[0].members).toHaveLength(3)
    expect(events.at(-1)).toEqual({ type: 'error', error: 'Cannot read final worker snapshot' })
    expect(workers(workspace.id)).toHaveLength(3)
    const health = await fetch(`${server.baseUrl}/api/ui/team-scenarios`, { headers: { cookie } })
    expect(health.status).toBe(200)
    expect((await health.json()).scenarios).toHaveLength(3)
  })

  test('streams progress and preserves failed members without treating an early exit as success', async () => {
    const server = await startTestServer()
    servers.push(server)
    const workspace = server.store.createWorkspace(server.dataDir, 'Failure progress')
    const cookie = await getUiCookie(server.baseUrl)
    const preset = server.store.settings.createCommandPreset({
      args: ['-e', 'process.exit(9)'],
      command: process.execPath,
      displayName: 'Exiting CLI',
      env: {},
      resumeArgsTemplate: null,
      sessionIdCapture: null,
      yoloArgsTemplate: null,
    })
    const response = await fetch(
      `${server.baseUrl}/api/ui/workspaces/${workspace.id}/team-scenarios/ship-feature`,
      {
        method: 'POST',
        headers: { accept: 'application/x-ndjson', 'content-type': 'application/json', cookie },
        body: JSON.stringify({ command_preset_id: preset.id }),
      }
    )
    expect(response.status).toBe(201)
    expect(response.headers.get('content-type')).toContain('application/x-ndjson')
    const events: ScenarioLaunchEvent[] = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(events[0]).toMatchObject({
      type: 'progress',
      members: [{ state: 'queued' }, { state: 'queued' }, { state: 'queued' }],
    })
    const result = events.at(-1)
    if (result?.type !== 'result') throw new Error('Missing final result')
    expect(result.result.created).toHaveLength(3)
    expect(result.result.started).toHaveLength(3)
    for (const member of result.result.started) {
      expect(member).toMatchObject({ ok: false, error: expect.stringContaining('exit 9') })
      expect(server.store.getAgent(workspace.id, member.id).status).toBe('stopped')
    }
    expect(server.store.listWorkers(workspace.id)).toHaveLength(3)
    expect(events.at(-2)).toMatchObject({
      type: 'progress',
      members: [{ state: 'failed' }, { state: 'failed' }, { state: 'failed' }],
    })
  }, 20_000)

  test('creates the whole team before starting, with at most two concurrent launches', async () => {
    const server = await startTestServer()
    servers.push(server)
    const workspace = server.store.createWorkspace(server.dataDir, 'Parallel scenario')
    const cookie = await getUiCookie(server.baseUrl)
    const preset = server.store.settings.createCommandPreset({
      args: ['-e', 'process.stdout.write("READY"); process.stdin.resume()'],
      command: process.execPath,
      displayName: 'Fixture CLI',
      env: {},
      resumeArgsTemplate: null,
      sessionIdCapture: null,
      yoloArgsTemplate: null,
    })
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const start = server.store.startAgent.bind(server.store)
    let pending = 0
    let maxPending = 0
    server.store.startAgent = async (...args) => {
      pending++
      maxPending = Math.max(maxPending, pending)
      try {
        await gate
        return await start(...args)
      } finally {
        pending--
      }
    }
    const request = fetch(
      `${server.baseUrl}/api/ui/workspaces/${workspace.id}/team-scenarios/ship-feature`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ command_preset_id: preset.id }),
      }
    )
    try {
      await vi.waitFor(() => expect(pending).toBe(2))
      expect(server.store.listWorkers(workspace.id)).toHaveLength(3)
      const repeated = await fetch(
        `${server.baseUrl}/api/ui/workspaces/${workspace.id}/team-scenarios/ship-feature`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ command_preset_id: preset.id }),
        }
      )
      const reused = await repeated.json()
      expect(repeated.status).toBe(201)
      expect(reused.created).toEqual([])
      expect(reused.reused).toHaveLength(3)
      expect(reused.started).toEqual([])
      expect(server.store.listWorkers(workspace.id)).toHaveLength(3)
    } finally {
      release()
    }
    const response = await request
    const body = await response.json()
    expect(response.status).toBe(201)
    expect(maxPending).toBe(2)
    expect(body.started).toHaveLength(3)
    expect(body.started.every((item: { ok: boolean }) => item.ok)).toBe(true)
    for (const item of body.started) {
      expect(server.store.getLiveRun(item.run_id).output).toContain('READY')
      server.store.stopAgentRun(item.run_id)
    }
  }, 20_000)

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
    expect(body.workers.map((worker) => worker.name)).toEqual(['Builder', 'Reviewer', 'Tester'])
    for (const worker of body.workers) {
      expect(worker.command_preset_id).toBe(preset.id)
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

test('scenario role names avoid occupied names and preserve existing members when the team is reused', async () => {
  const server = await startTestServer()
  servers.push(server)
  const cookie = await getUiCookie(server.baseUrl)
  const workspace = server.store.createWorkspace(server.dataDir, 'Existing team')
  const preset = createPreset(server, process.execPath)
  const existing = server.store.addWorkers(workspace.id, [
    { name: 'Builder', role: 'custom', description: 'Manual member' },
    { name: 'Builder 2', role: 'coder', description: 'Independent coder' },
    { name: 'Reviewer', role: 'custom', description: 'Another manual member' },
    {
      name: 'Legacy tester',
      role: 'tester',
      description: 'Runs focused validation and reports reproducible failures.',
    },
  ])
  const launch = () =>
    fetch(`${server.baseUrl}/api/ui/workspaces/${workspace.id}/team-scenarios/ship-feature`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ autostart: false, command_preset_id: preset.id }),
    })
  const response = await launch()
  expect(response.status).toBe(201)
  const created = await response.json()
  expect(created.created).toHaveLength(2)
  expect(created.reused).toEqual([existing[3]?.id])
  expect(created.workers.map((worker: { name: string }) => worker.name)).toEqual([
    'Builder',
    'Builder 2',
    'Reviewer',
    'Legacy tester',
    'Builder 3',
    'Reviewer 2',
  ])
  const repeated = await launch()
  expect(repeated.status).toBe(201)
  const reused = await repeated.json()
  expect(reused.created).toEqual([])
  expect(reused.reused).toHaveLength(3)
  expect(reused.workers).toEqual(created.workers)
})
