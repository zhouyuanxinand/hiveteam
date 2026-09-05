import { afterEach, describe, expect, test, vi } from 'vitest'

import { runTeamCommand } from '../../src/cli/team.js'

const { fetchLocalRuntimeMock } = vi.hoisted(() => ({
  fetchLocalRuntimeMock: vi.fn(),
}))

vi.mock('../../src/cli/local-http.js', () => ({
  fetchLocalRuntime: fetchLocalRuntimeMock,
}))

const originalEnv = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnv }
  vi.restoreAllMocks()
  fetchLocalRuntimeMock.mockReset()
})

describe('team cli help', () => {
  test('prints usage without requiring Hive agent environment', async () => {
    process.env = {}
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(runTeamCommand(['--help'])).resolves.toBeUndefined()

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n')
    expect(output).toContain('Usage:')
    expect(output).toContain('team list')
    expect(output).toContain('team guide <core|dispatch|tasks|memory|workflow|member>')
    expect(output).toContain('team send "<worker-name>" "<task>"')
    expect(output).toContain('team cancel --dispatch <dispatch-id> "<reason>"')
    expect(output).toContain(
      'team goal report --goal <goal-id> --status progress|done|blocked|failed'
    )
    expect(output).toContain('team report "<result>"')
    expect(output).toContain('team status "<current status>"')
    expect(output).not.toContain('--success')
    expect(output).not.toContain('--failed')
  })

  test('prints a focused generated guide without requiring Hive agent environment', async () => {
    process.env = {}
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(runTeamCommand(['guide', 'dispatch'])).resolves.toBeUndefined()

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n')
    expect(output).toContain('## Guide: dispatch')
    expect(output).toContain('team send "<worker-name>" "<task>"')
    expect(output).toContain('team goal report --goal <goal-id>')
  })

  test('rejects an unknown guide topic with the guide usage', async () => {
    await expect(runTeamCommand(['guide', 'unknown'])).rejects.toThrow(
      'Usage: team guide <core|dispatch|tasks|memory|workflow|member>'
    )
  })

  test('team report warns when Hive records the report but cannot live-deliver it', async () => {
    process.env = {
      HIVE_AGENT_ID: 'worker-1',
      HIVE_AGENT_TOKEN: 'token-1',
      HIVE_PORT: '12345',
      HIVE_PROJECT_ID: 'workspace-1',
    }
    const body = JSON.stringify({
      dispatch_id: 'dispatch-1',
      forward_error: 'No active run for agent: workspace-1:orchestrator',
      forwarded: false,
      ok: true,
    })
    fetchLocalRuntimeMock.mockResolvedValue({
      json: async () => JSON.parse(body) as unknown,
      ok: true,
      status: 202,
      text: async () => body,
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await runTeamCommand(['report', 'Done'])

    expect(errorSpy).toHaveBeenCalledWith(
      'HiveTeam recorded the report, but could not deliver it to Orchestrator in real time: No active run for agent: workspace-1:orchestrator'
    )
  })
})
