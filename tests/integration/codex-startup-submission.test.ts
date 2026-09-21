import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import headlessTerminalModule from '@xterm/headless'
import { afterEach, expect, test } from 'vitest'
import WebSocket from 'ws'
import { buildAgentStartupInstructions } from '../../src/server/agent-startup-instructions.js'
import { startAuthorizedTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
const waitFor = async (check: () => boolean, timeout = 10_000) => {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Codex did not accept the startup message')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
const setup = async (mode: string) => {
  const server = await startAuthorizedTestServer()
  cleanups.push(server.close)
  const cookie = await getUiCookie(server.baseUrl)
  const workspace = server.store.createWorkspace(server.dataDir, 'Startup regression')
  const agent = server.store.getWorkspaceSnapshot(workspace.id).agents[0]
  if (!agent) throw new Error('Expected Orchestrator')
  const journal = join(server.dataDir, 'accepted-input.json')
  server.store.configureAgentLaunch(workspace.id, agent.id, {
    command: process.execPath,
    args: [resolve('tests/fixtures/codex-startup-tui.mjs'), journal, mode],
    interactiveCommand: 'codex',
    presetAugmentationDisabled: true,
  })
  const response = await fetch(
    `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${agent.id}/start`,
    {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ hive_port: new URL(server.baseUrl).port }),
    }
  )
  expect(response.status).toBe(201)
  const run = (await response.json()) as { run_id: string }
  await waitFor(() => server.store.getLiveRun(run.run_id).output.includes('›'))
  const state = () =>
    JSON.parse(readFileSync(journal, 'utf8')) as {
      accepted: string[]
      pastes: number
      enters: number
      draft: string
      hooksChoice: string
      ready: boolean
    }
  return { server, runId: run.run_id, state, workspace, agent, cookie }
}

const attachTerminal = async (context: Awaited<ReturnType<typeof setup>>, appendDraft = false) => {
  const terminal = new headlessTerminalModule.Terminal({ cols: 80, rows: 24 })
  const socket = new WebSocket(
    `${context.server.baseUrl.replace('http:', 'ws:')}/ws/terminal/${context.runId}/io`,
    { headers: { cookie: context.cookie } }
  )
  socket.on('message', (data) => terminal.write(data.toString()))
  terminal.onData((data) => socket.send(data + (appendDraft ? 'USER_DRAFT' : '')))
  cleanups.unshift(async () => {
    socket.close()
    terminal.dispose()
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return terminal
}

test('automatic xterm replies over the terminal websocket do not cancel startup submission', async () => {
  const context = await setup('terminal-replies')
  const terminal = await attachTerminal(context)
  await waitFor(() => context.state().pastes === 1)
  // Feed an actual xterm query after the startup paste. Windows PTY backends
  // can consume device queries themselves before forwarding stdout to xterm.
  terminal.write('\x1b[?2026$p')
  await waitFor(() => context.state().accepted.length === 1)
  expect(context.state()).toMatchObject({
    accepted: [buildAgentStartupInstructions(context)],
    pastes: 1,
    enters: 2,
    replies: ['\x1b[?2026;2$y'],
  })
}, 20_000)

test('a terminal reply mixed with a user draft still stops automatic startup submission', async () => {
  const context = await setup('terminal-replies')
  const terminal = await attachTerminal(context, true)
  await waitFor(() => context.state().pastes === 1)
  terminal.write('\x1b[?2026$p')
  await waitFor(() => context.state().draft === 'USER_DRAFT')
  await new Promise((resolve) => setTimeout(resolve, 3500))
  expect(context.state()).toMatchObject({
    accepted: [],
    pastes: 1,
    enters: 0,
    replies: ['\x1b[?2026;2$y'],
    draft: 'USER_DRAFT',
  })
}, 15_000)

test.each([
  'collapsed',
  'expanded',
  'trust',
  'delayed-composer',
  'late-trust',
])('Codex accepts a slow %s startup paste exactly once after an ignored Enter', async (mode) => {
  const { state, workspace, agent } = await setup(mode)
  await waitFor(() => state().accepted.length === 1)
  expect(state()).toMatchObject({
    accepted: [buildAgentStartupInstructions({ agent, workspace })],
    pastes: 1,
    enters: 2,
    prematurePastes: 0,
  })
  await new Promise((resolve) => setTimeout(resolve, 1200))
  expect(state().accepted).toHaveLength(1)
  expect(state().enters).toBe(2)
  if (mode === 'trust' || mode === 'late-trust')
    expect(state().hooksChoice).toBe('continue-without-hooks')
}, 20_000)

test('a user edit after the startup paste cancels automatic submission', async () => {
  const { server, runId, state } = await setup('collapsed')
  await waitFor(() => state().pastes === 1)
  server.store.writeRunInput(runId, 'USER_DRAFT')
  await new Promise((resolve) => setTimeout(resolve, 3500))
  expect(state()).toMatchObject({ accepted: [], pastes: 1, enters: 0, draft: 'USER_DRAFT' })
}, 15_000)

test('a confirmation over a startup paste never receives automatic Enter', async () => {
  const { state } = await setup('blocked')
  await waitFor(() => state().pastes === 1)
  await new Promise((resolve) => setTimeout(resolve, 3500))
  expect(state()).toMatchObject({ accepted: [], pastes: 1, enters: 0 })
}, 15_000)

test('startup instructions never overwrite an existing user draft', async () => {
  const { state } = await setup('existing-draft')
  await new Promise((resolve) => setTimeout(resolve, 2500))
  expect(state()).toMatchObject({ accepted: [], pastes: 0, enters: 0 })
}, 15_000)

test.skipIf(process.platform !== 'win32')(
  'Windows paste-burst buffering is explicitly flushed before startup is submitted',
  async () => {
    const { state, workspace, agent } = await setup('burst')
    await waitFor(() => state().accepted.length === 1)
    expect(state()).toMatchObject({
      accepted: [buildAgentStartupInstructions({ agent, workspace })],
      pastes: 1,
      enters: 2,
      flushed: true,
    })
  },
  15_000
)

test('a browser resize during startup preserves the current composer and submits it once', async () => {
  const { server, runId, state, workspace, agent } = await setup('resized')
  await waitFor(() => state().ready)
  server.store.resizeAgentRun(runId, 120, 50)
  await waitFor(() => state().accepted.length === 1)
  expect(state()).toMatchObject({
    accepted: [buildAgentStartupInstructions({ agent, workspace })],
    pastes: 1,
    enters: 2,
  })
}, 20_000)
