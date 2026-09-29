import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import WebSocket from 'ws'
import { writeNodeCli } from '../helpers/platform-cli.js'
import { startAuthorizedTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.unstubAllEnvs()
})

const setup = async (bindSkill = true, deferredReady = false) => {
  const root = mkdtempSync(join(tmpdir(), 'hive-terminal-grill-'))
  cleanups.push(() => {
    if (!resolve(root).startsWith(resolve(tmpdir(), 'hive-terminal-grill-')))
      throw new Error('Unexpected fixture directory')
    rmSync(root, { recursive: true, force: true, maxRetries: 10 })
  })
  vi.stubEnv('CODEX_HOME', join(root, 'native-home'))
  const command = writeNodeCli(
    root,
    'codex',
    `
if (process.argv.includes('--help')) {
  console.log('Codex CLI\\nUsage: codex [OPTIONS]\\nOptions:\\n --no-daemon  Run without shared background server')
  process.exit(0)
}
process.env.GRILL_TERMINAL_FIXTURE_ROOT = ${JSON.stringify(root)}
process.env.GRILL_TERMINAL_DEFER_READY = ${JSON.stringify(deferredReady ? '1' : '0')}
await import(${JSON.stringify(new URL('../fixtures/grill-terminal-tui.mjs', import.meta.url).href)})
`
  )
  vi.stubEnv('PATH', root + delimiter + process.env.PATH)
  // New Windows sessions pass their full prompt through native argv. Resolve
  // the synthetic Node CLI directly instead of its cmd.exe convenience shim.
  if (process.platform === 'win32') vi.stubEnv('PATHEXT', `.MJS;${process.env.PATHEXT ?? ''}`)
  mkdirSync(join(root, 'workspace'))
  const server = await startAuthorizedTestServer({ dataDir: join(root, 'data') })
  cleanups.push(() => server.close())
  const workspace = server.store.createWorkspace(join(root, 'workspace'), 'Terminal interview')
  const agentId = `${workspace.id}:orchestrator`
  if (bindSkill) {
    const pack = join(root, 'pack')
    mkdirSync(join(pack, 'grill-with-docs'), { recursive: true })
    writeFileSync(
      join(pack, 'grill-with-docs/SKILL.md'),
      '---\nname: grill-with-docs\ndescription: Interview\n---\nPINNED-TERMINAL-INTERVIEW'
    )
    const release = await server.store.skills.resolvePack({
      packName: 'matt',
      source: { type: 'local', path: pack },
    })
    const plan = await server.store.skills.plan(workspace.id, {
      action: 'bind',
      packName: 'matt',
      releaseId: release.id,
      profiles: { orchestrator: ['grill-with-docs'], custom: [] },
      nativeExposure: [],
    })
    await server.store.skills.applyPlan(workspace.id, plan.id)
  }
  server.store.configureAgentLaunch(workspace.id, agentId, {
    command,
    args: [],
    commandPresetId: 'codex',
    presetAugmentationDisabled: true,
    sessionIdCapture: {
      source: 'codex_session_jsonl_dir',
      pattern: '~/.codex/sessions/**/*.jsonl',
    },
  })
  const cookie = await getUiCookie(server.baseUrl)
  const response = await fetch(
    `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/start`,
    { method: 'POST', headers: { cookie } }
  )
  expect(response.status, await response.clone().text()).toBe(201)
  const { run_id: runId } = (await response.json()) as { run_id: string }
  await expect
    .poll(() => server.store.getLiveRun(runId).output, { timeout: 10000 })
    .toContain(deferredReady ? 'FIXTURE_BOOTING' : 'FIXTURE_READY')
  const connect = async (targetRunId = runId) => {
    const clientId = randomUUID()
    const base = `${server.baseUrl.replace('http:', 'ws:')}/ws/terminal/${targetRunId}`
    const messages: Array<Record<string, unknown>> = []
    const control = new WebSocket(`${base}/control?clientId=${clientId}`, { headers: { cookie } })
    control.on('message', (raw) => messages.push(JSON.parse(raw.toString())))
    cleanups.push(() => control.terminate())
    await new Promise<void>((resolve, reject) => {
      control.once('open', resolve)
      control.once('error', reject)
    })
    const io = new WebSocket(`${base}/io?clientId=${clientId}`, { headers: { cookie } })
    io.on('message', (raw) => {
      if (control.readyState === WebSocket.OPEN)
        control.send(
          JSON.stringify({ type: 'output_ack', bytes: Buffer.byteLength(raw.toString()) })
        )
    })
    cleanups.push(() => io.terminate())
    await new Promise<void>((resolve, reject) => {
      io.once('open', resolve)
      io.once('error', reject)
    })
    await expect.poll(() => messages.some((message) => message.type === 'restore')).toBe(true)
    return { control, io, messages }
  }
  const client = await connect()
  const submitted = (id = agentId) => {
    const text = readFileSync(join(root, `${id.replaceAll(':', '_')}.submitted.jsonl`), 'utf8')
    return text.trim()
      ? text
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { text: string })
      : []
  }
  return {
    ...server,
    ...client,
    root,
    workspace,
    agentId,
    runId,
    cookie,
    command,
    connect,
    submitted,
  }
}

test('submitting a grill command through the terminal creates a member and delivers the pinned interview once', async () => {
  const ctx = await setup()
  expect(ctx.store.listWorkers(ctx.workspace.id)).toHaveLength(0)
  ctx.io.send('$grill-')
  ctx.io.send('with-docs Clarify the mail plan')
  ctx.io.send('\r')
  ctx.io.send('\r')
  await expect
    .poll(() => ctx.store.listWorkers(ctx.workspace.id), { timeout: 15000 })
    .toHaveLength(1)
  const worker = ctx.store.listWorkers(ctx.workspace.id)[0]
  if (!worker) throw new Error('Expected the interview member to be created')
  expect(worker.name).toBe('需求访谈员')
  await expect
    .poll(
      () =>
        ctx.messages.find(
          (message) =>
            message.type === 'grill_handoff' &&
            ['submitted', 'queued'].includes(String(message.status))
        ),
      { timeout: 15000 }
    )
    .toMatchObject({ worker_id: worker.id, worker_name: '需求访谈员', created: true })
  await expect
    .poll(() => ctx.store.listDispatches(ctx.workspace.id), { timeout: 15000 })
    .toContainEqual(expect.objectContaining({ toAgentId: worker.id, status: 'submitted' }))
  await expect
    .poll(() => ctx.submitted(worker.id), { timeout: 15000 })
    .toContainEqual({ text: expect.stringContaining('PINNED-TERMINAL-INTERVIEW') })
  expect(ctx.submitted(worker.id)[0]?.text).toContain('Clarify the mail plan')
  expect(ctx.submitted()).toEqual([])
  ctx.io.send('\r\r')
  ctx.io.send('ordinary follow-up\r')
  await expect.poll(() => ctx.submitted()).toEqual([{ text: 'ordinary follow-up' }])
  expect(ctx.store.listWorkers(ctx.workspace.id)).toHaveLength(1)
  expect(ctx.store.listDispatches(ctx.workspace.id)).toHaveLength(1)
}, 45000)

test('a bare grill skill transfers the request to ask about the topic to the new member', async () => {
  const ctx = await setup()
  ctx.io.send('$grill-with-docs\r')
  await expect
    .poll(() => ctx.store.listWorkers(ctx.workspace.id), { timeout: 15000 })
    .toHaveLength(1)
  const worker = ctx.store.listWorkers(ctx.workspace.id)[0]
  if (!worker) throw new Error('Expected the interview member to be created')
  await expect.poll(() => ctx.submitted(worker.id), { timeout: 15000 }).toHaveLength(1)
  expect(ctx.submitted(worker.id)[0]?.text).toContain('PINNED-TERMINAL-INTERVIEW')
  expect(ctx.store.listDispatches(ctx.workspace.id)[0]?.text).toMatch(/先向用户确认|First ask/u)
  expect(ctx.submitted()).toEqual([])
}, 30000)

test('an early viewer can start an interview after device replies precede the first composer', async () => {
  const ctx = await setup(true, true)
  expect(ctx.store.getLiveRun(ctx.runId).output).not.toContain('FIXTURE_READY')
  ctx.io.send('\u001b[I')
  ctx.io.send('\u001b[?1;2c')
  // ConPTY may consume the device replies itself. A non-editing Ctrl-E is an
  // ordered PTY receipt without clearing the draft or repairing its tracker.
  ctx.io.send('\u0005')
  await expect
    .poll(() => readFileSync(join(ctx.root, `${ctx.agentId.replaceAll(':', '_')}.raw`), 'utf8'))
    .toContain('\u0005')
  writeFileSync(join(ctx.root, 'show-composer'), '')
  await expect.poll(() => ctx.store.getLiveRun(ctx.runId).output).toContain('FIXTURE_READY')
  ctx.io.send('$grill-with-docs\r')
  await expect
    .poll(() => ctx.store.listWorkers(ctx.workspace.id), { timeout: 15000 })
    .toHaveLength(1)
  const worker = ctx.store.listWorkers(ctx.workspace.id)[0]
  if (!worker) throw new Error('Expected the interview member after composer became ready')
  await expect
    .poll(() => ctx.submitted(worker.id), { timeout: 15000 })
    .toContainEqual({ text: expect.stringContaining('PINNED-TERMINAL-INTERVIEW') })
  expect(ctx.submitted()).toEqual([])
}, 35000)

test('system-delivered input does not prevent the next user grill handoff', async () => {
  const ctx = await setup()
  ctx.io.send('initial user message\r')
  await expect.poll(() => ctx.submitted()).toEqual([{ text: 'initial user message' }])

  // Startup prompts and worker reports reach the same PTY outside the browser
  // router. This must invalidate and safely rebuild its editor baseline.
  ctx.store.writeRunInput(ctx.runId, 'system-delivered report\r')
  await expect
    .poll(() => ctx.submitted())
    .toEqual([{ text: 'initial user message' }, { text: 'system-delivered report' }])
  const currentViewer = await ctx.connect()
  expect(currentViewer.messages.find((message) => message.type === 'restore')?.snapshot).toContain(
    'Ask Codex to do anything'
  )

  ctx.io.send('$grill-with-docs\r')
  await expect
    .poll(() => ctx.store.listWorkers(ctx.workspace.id), { timeout: 15000 })
    .toHaveLength(1)
  const worker = ctx.store.listWorkers(ctx.workspace.id)[0]
  if (!worker) throw new Error('Expected the interview member after system input')
  await expect
    .poll(() => ctx.submitted(worker.id), { timeout: 15000 })
    .toContainEqual({ text: expect.stringContaining('PINNED-TERMINAL-INTERVIEW') })
  expect(ctx.submitted()).toEqual([
    { text: 'initial user message' },
    { text: 'system-delivered report' },
  ])
}, 35000)

test('mentions and an erased grill draft remain ordinary terminal input', async () => {
  const ctx = await setup()
  ctx.io.send('$grill-with-docs')
  ctx.io.send('\u0005\u0015Explain $grill-with-docs usage\r')
  await expect.poll(() => ctx.submitted()).toEqual([{ text: 'Explain $grill-with-docs usage' }])
  ctx.io.send('$grill-with-docx')
  ctx.io.send('\u007fumentation\r')
  await expect.poll(() => ctx.submitted()).toHaveLength(2)
  expect(ctx.submitted()[1]).toEqual({ text: '$grill-with-documentation' })
  expect(ctx.store.listWorkers(ctx.workspace.id)).toHaveLength(0)
  expect(ctx.store.listDispatches(ctx.workspace.id)).toHaveLength(0)
  expect(ctx.messages.filter((message) => message.type === 'grill_handoff')).toEqual([])
}, 20000)

test('a missing pinned skill reports failure and keeps the interview out of the main conversation', async () => {
  const ctx = await setup(false)
  ctx.io.send('$grill-with-docx')
  ctx.io.send('\u007fs\r')
  await expect
    .poll(
      () =>
        ctx.messages.find(
          (message) => message.type === 'grill_handoff' && message.status === 'failed'
        ),
      { timeout: 10000 }
    )
    .toMatchObject({ worker_id: null, created: false, message: expect.any(String) })
  expect(ctx.store.listWorkers(ctx.workspace.id)).toHaveLength(0)
  expect(ctx.store.listDispatches(ctx.workspace.id)).toHaveLength(0)
  expect(ctx.submitted()).toEqual([])
  ctx.io.send('\u0005\u0015ordinary input after failure\r')
  await expect.poll(() => ctx.submitted()).toEqual([{ text: 'ordinary input after failure' }])
}, 25000)

test('worker and workspace shell inputs do not create recursive interview members', async () => {
  const ctx = await setup()
  const worker = ctx.store.addWorker(ctx.workspace.id, { name: 'Existing reviewer', role: 'coder' })
  ctx.store.configureAgentLaunch(ctx.workspace.id, worker.id, {
    command: ctx.command,
    args: [],
    commandPresetId: 'codex',
    presetAugmentationDisabled: true,
    sessionIdCapture: {
      source: 'codex_session_jsonl_dir',
      pattern: '~/.codex/sessions/**/*.jsonl',
    },
  })
  const response = await fetch(
    `${ctx.baseUrl}/api/workspaces/${ctx.workspace.id}/agents/${worker.id}/start`,
    { method: 'POST', headers: { cookie: ctx.cookie } }
  )
  expect(response.status).toBe(201)
  const { run_id: workerRunId } = (await response.json()) as { run_id: string }
  await expect
    .poll(() => ctx.store.getLiveRun(workerRunId).output, { timeout: 10000 })
    .toContain('FIXTURE_READY')
  const workerClient = await ctx.connect(workerRunId)
  workerClient.io.send('$grill-with-docs\r')
  await expect.poll(() => ctx.submitted(worker.id)).toEqual([{ text: '$grill-with-docs' }])
  const shellResponse = await fetch(
    `${ctx.baseUrl}/api/workspaces/${ctx.workspace.id}/shell/start`,
    { method: 'POST', headers: { cookie: ctx.cookie } }
  )
  expect(shellResponse.status).toBe(201)
  const { run_id: shellRunId } = (await shellResponse.json()) as { run_id: string }
  const shellClient = await ctx.connect(shellRunId)
  shellClient.io.send('$grill-with-docs\recho passed > shell-grill-result.txt\r')
  await expect
    .poll(() => readFileSync(join(ctx.workspace.path, 'shell-grill-result.txt'), 'utf8').trim(), {
      timeout: 10000,
    })
    .toBe('passed')
  expect(ctx.store.listWorkers(ctx.workspace.id).map((member) => member.id)).toEqual([worker.id])
  expect(ctx.store.listDispatches(ctx.workspace.id)).toHaveLength(0)
  expect(
    [...workerClient.messages, ...shellClient.messages].filter(
      (message) => message.type === 'grill_handoff'
    )
  ).toEqual([])
}, 30000)

test('an unauthenticated websocket cannot submit a grill command', async () => {
  const ctx = await setup()
  const socket = new WebSocket(
    `${ctx.baseUrl.replace('http:', 'ws:')}/ws/terminal/${ctx.runId}/io?clientId=${randomUUID()}`
  )
  cleanups.push(() => socket.terminate())
  const status = await new Promise<number>((resolve, reject) => {
    socket.once('unexpected-response', (_request, response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    socket.once('open', () => reject(new Error('Unauthenticated terminal socket opened')))
    socket.once('error', reject)
  })
  expect(status).toBe(401)
  expect(ctx.submitted()).toEqual([])
  expect(ctx.store.listWorkers(ctx.workspace.id)).toHaveLength(0)
  expect(ctx.store.listDispatches(ctx.workspace.id)).toHaveLength(0)
}, 20000)
