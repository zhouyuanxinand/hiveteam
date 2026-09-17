// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { ScenarioLaunchMember } from '../../src/shared/team-scenario-launch.js'
import { TEAM_SCENARIOS } from '../../src/shared/team-scenarios.js'
import { launchTeamScenario, listTeamScenarios } from '../../web/src/api.js'
import { TeamScenarioDialog } from '../../web/src/worker/TeamScenarioDialog.js'

vi.mock('../../web/src/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../web/src/api.js')>()),
  listTeamScenarios: vi.fn(),
  launchTeamScenario: vi.fn(),
}))
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

test('shows live member progress and preserves partial failure details for individual retry', async () => {
  vi.mocked(listTeamScenarios).mockResolvedValue({
    scenarios: TEAM_SCENARIOS,
    presets: [{ id: 'codex', displayName: 'Codex', available: true, installHint: null }],
  })
  let report: ((members: ScenarioLaunchMember[]) => void) | undefined
  let finish: (result: Awaited<ReturnType<typeof launchTeamScenario>>) => void = () => {}
  vi.mocked(launchTeamScenario).mockImplementation(async (_workspace, _scenario, input) => {
    report = input?.onProgress
    return await new Promise((resolve) => {
      finish = resolve
    })
  })
  const close = vi.fn()
  const changed = vi.fn()
  render(
    <TeamScenarioDialog open workspaceId="workspace" onClose={close} onWorkersChanged={changed} />
  )
  const launch = await screen.findByTestId('team-scenario-launch')
  await waitFor(() => expect(launch).toBeEnabled())
  fireEvent.click(launch)
  fireEvent.click(launch)
  const member: ScenarioLaunchMember = {
    id: 'alice',
    name: '开发成员',
    role: 'coder',
    state: 'starting',
    error: null,
    duration_ms: null,
  }
  act(() => report?.([member]))
  expect(screen.getByText('开发成员')).toBeVisible()
  expect(screen.getByText('Starting process…')).toBeVisible()
  expect(screen.getByTestId('team-scenario-preset')).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  expect(launchTeamScenario).toHaveBeenCalledTimes(1)
  await act(async () => {
    report?.([{ ...member, state: 'failed', error: 'fixture CLI failed' }])
    finish({
      created: ['alice'],
      reused: [],
      workers: [],
      started: [{ id: 'alice', ok: false, error: 'fixture CLI failed', run_id: null }],
    })
  })
  expect(screen.getByText('fixture CLI failed')).toBeVisible()
  expect(screen.getByRole('alert')).toHaveTextContent('retry them individually')
  expect(close).not.toHaveBeenCalled()
  expect(launch).toBeDisabled()
})
