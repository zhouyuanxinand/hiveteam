import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { SkillPackChangeError } from '../../src/server/skill-pack-operation-errors.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

vi.unmock('../../src/server/default-workspace-skill-pack.js')
const servers: Awaited<ReturnType<typeof startTestServer>>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) await server.close()
})

test('basic creation with a cold cache works offline, preserves project files and records honest metrics', async () => {
  const server = await startTestServer()
  servers.push(server)
  const cookie = await getUiCookie(server.baseUrl)
  vi.spyOn(server.store.skills, 'resolvePack').mockRejectedValue(
    new SkillPackChangeError('release_unavailable', 'Fixture offline')
  )
  const path = join(server.dataDir, '中文 离线')
  mkdirSync(path)
  mkdirSync(join(path, '.hive'))
  writeFileSync(join(path, '.hive', 'tasks.md'), '- [ ] existing\n')
  writeFileSync(join(path, 'README.md'), 'local project\n')
  const response = await fetch(`${server.baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      path,
      name: 'Offline',
      initialization_mode: 'basic',
      autostart_orchestrator: false,
    }),
  })
  expect(response.status).toBe(201)
  const workspace = await response.json()
  expect(readFileSync(join(path, '.hive', 'tasks.md'), 'utf8')).toBe('- [ ] existing\n')
  expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('local project\n')
  expect(server.store.listTerminalRuns(workspace.id)).toEqual([])
  const view = await fetch(`${server.baseUrl}/api/ui/workspaces/${workspace.id}/onboarding`, {
    headers: { cookie },
  })
  expect(await view.json()).toMatchObject({
    initialization: { mode: 'basic', first_report_at: null, first_report_duration_ms: null },
  })
  const packsPath = join(server.dataDir, 'packs')
  mkdirSync(packsPath)
  const failed = await fetch(`${server.baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      path: packsPath,
      name: 'Packs',
      initialization_mode: 'packs',
      autostart_orchestrator: false,
    }),
  })
  expect(failed.ok).toBe(false)
  expect(server.store.listWorkspaces().map((w) => w.id)).toEqual([workspace.id])
  const metrics = await fetch(`${server.baseUrl}/api/settings/onboarding-metrics`, {
    headers: { cookie },
  })
  expect(await metrics.json()).toMatchObject({
    model_cost: null,
    workloads: expect.arrayContaining([
      {
        mode: 'basic',
        attempts: 1,
        succeeded: 1,
        failed: 0,
        interrupted: 0,
        mean_creation_ms: expect.any(Number),
        mean_first_report_ms: null,
        reports_observed: 0,
      },
      {
        mode: 'packs',
        attempts: 1,
        succeeded: 0,
        failed: 1,
        interrupted: 0,
        mean_creation_ms: null,
        mean_first_report_ms: null,
        reports_observed: 0,
      },
    ]),
  })
})
