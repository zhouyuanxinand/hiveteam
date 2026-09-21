import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import * as profiles from '../../src/server/cli-readiness-profile.js'
import { authorizeSyntheticAgent } from '../helpers/authorized-runtime.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Awaited<ReturnType<typeof startTestServer>>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const server of servers.splice(0)) await server.close()
})
const setup = async () => {
  const server = await startTestServer()
  servers.push(server)
  const path = join(server.dataDir, 'fixture')
  mkdirSync(path)
  vi.stubEnv('CODEX_HOME', path)
  const workspace = server.store.createWorkspace(path, 'Readiness')
  const agentId = `${workspace.id}:orchestrator`
  const cookie = await getUiCookie(server.baseUrl)
  const url = `${server.baseUrl}/api/ui/workspaces/${workspace.id}/agents/${encodeURIComponent(agentId)}/readiness`
  const view = async () => (await fetch(url, { headers: { cookie } })).json()
  const probe = (fingerprint: string) =>
    fetch(url, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ expected_cli_fingerprint: fingerprint }),
    })
  return { ...server, workspace, agentId, cookie, url, view, probe }
}

test('discovery distinguishes missing and unknown CLIs without executing them; local authentication is required', async () => {
  const f = await setup()
  f.store.configureAgentLaunch(f.workspace.id, f.agentId, {
    command: 'hive-no-such-cli-fixture',
    args: [],
  })
  expect(await f.view()).toMatchObject({
    state: 'missing',
    command_found: false,
    authentication: 'unknown',
    model_request_performed: false,
  })
  f.store.configureAgentLaunch(f.workspace.id, f.agentId, { command: process.execPath, args: [] })
  await authorizeSyntheticAgent(f.store, f.workspace.id, f.agentId)
  const view = await f.view()
  expect(view).toMatchObject({ state: 'unverified', command_found: true, probe_available: false })
  expect(await (await f.probe(view.cli_fingerprint)).json()).toMatchObject({
    state: 'unverified',
    authentication: 'unknown',
  })
  expect((await fetch(f.url)).status).toBe(403)
  expect((await f.probe('changed')).status).toBe(409)
})

test('fixed diagnostic child processes classify authentication and never expose raw secret output', async () => {
  const f = await setup()
  f.store.configureAgentLaunch(f.workspace.id, f.agentId, { command: process.execPath, args: [] })
  await authorizeSyntheticAgent(f.store, f.workspace.id, f.agentId)
  const selectProfile = vi.spyOn(profiles, 'getCliReadinessProfile')
  for (const [output, code, state, authentication] of [
    ['Not logged in', 1, 'authentication_required', 'missing'],
    ['Logged in using an API key - synthetic-SECRET', 0, 'ready', 'present'],
    ['unexpected synthetic-SECRET', 2, 'failed', 'unknown'],
  ] as const) {
    selectProfile.mockReturnValue({
      protocol: 'codex-login-status-v1',
      args: ['-e', `process.stderr.write(${JSON.stringify(output)});process.exitCode=${code}`],
    })
    const view = await f.view()
    const response = await f.probe(view.cli_fingerprint)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      state,
      authentication,
      probe_exit_code: code,
      model_request_performed: false,
    })
    expect(JSON.stringify(body)).not.toContain('SECRET')
    expect(f.store.listTerminalRuns(f.workspace.id)).toEqual([])
  }
})
