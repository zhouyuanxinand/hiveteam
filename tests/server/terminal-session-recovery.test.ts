import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import WebSocket from 'ws'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const setup = async (codex = true) => {
  const directory = mkdtempSync(join(tmpdir(), 'hive-session-recovery-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const sessionId = randomUUID()
  const sessionRoot = join(directory, 'codex')
  mkdirSync(join(sessionRoot, 'sessions'), { recursive: true })
  const historyPath = join(sessionRoot, 'sessions', `rollout-${sessionId}.jsonl`)
  const history = `${JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: directory } })}\n`
  const script = join(directory, 'fixture.mjs')
  const ownerPath = join(directory, 'owner')
  const inputPath = join(directory, 'input.txt')
  writeFileSync(ownerPath, '')
  writeFileSync(inputPath, '')
  // Replay the native Codex ownership screen through a real PTY, including a
  // split title and a screen repaint. No production detection is mocked.
  writeFileSync(
    script,
    `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(historyPath)}, ${JSON.stringify(history)} + JSON.stringify({ binding: 'Hive session binding: workspace_id=' + process.env.HIVE_PROJECT_ID + '; agent_id=' + process.env.HIVE_AGENT_ID }) + '\\n')
process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
const title = 'This conversation is open in another app'
const details = 'Close it there and press R to continue here.'
const footer = 'r retry    esc/ctrl+c/q exit    ctrl+t transcript'
const locked = () => process.stdout.write('\\x1b[2J\\x1b[H' + title + '\\r\\n' + details + '\\r\\n' + footer)
const ready = () => process.stdout.write('\\x1b[2J\\x1b[H› Ask Codex to do anything\\r\\nOriginal session: ${sessionId}\\r\\n')
process.stdin.on('data', chunk => {
  appendFileSync(${JSON.stringify(inputPath)}, chunk)
  for (const key of chunk) {
    if (key === 'r') {
      if (existsSync(${JSON.stringify(ownerPath)})) {
        process.stdout.write('\\x1b[2J\\x1b[H')
        setTimeout(locked, 100)
      } else ready()
    }
    if (key === 'h') process.stdout.write('\\r\\n' + Array(30).fill('history').join('\\r\\n') + '\\r\\n› Normal composer')
    if (key === 'q') process.exit(0)
  }
})
process.stdout.write('\\x1b[2J\\x1b[HThis conversation is ')
setTimeout(() => process.stdout.write('open in another app\\r\\n' + details + '\\r\\n' + footer), 30)
`
  )
  const server = await startTestServer()
  cleanups.push(() => server.close())
  const cookie = await getUiCookie(server.baseUrl)
  const workspace = server.store.createWorkspace(directory, 'Recovery')
  const worker = server.store.addWorker(workspace.id, { name: 'Recovery worker', role: 'coder' })
  server.store.configureAgentLaunch(workspace.id, worker.id, {
    command: process.execPath,
    args: [script],
    commandPresetId: codex ? 'codex' : null,
    presetAugmentationDisabled: true,
    ...(codex
      ? {
          sessionIdCapture: {
            source: 'codex_session_jsonl_dir' as const,
            pattern: `${sessionRoot}/sessions/**/*.jsonl`,
          },
        }
      : {}),
  })
  const run = await server.store.startAgent(workspace.id, worker.id, {
    hivePort: new URL(server.baseUrl).port,
  })
  await expect.poll(() => server.store.getLiveRun(run.runId).output).toContain('ctrl+t transcript')
  if (codex) {
    await expect
      .poll(() => server.store.listTerminalRuns(workspace.id)[0]?.thread_id)
      .toBe(sessionId)
  }
  const messages: Array<Record<string, unknown>> = []
  const url = server.baseUrl.replace('http:', 'ws:')
  const connect = async () => {
    const socket = new WebSocket(
      `${url}/ws/terminal/${run.runId}/control?clientId=${randomUUID()}`,
      { headers: { cookie } }
    )
    socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())))
    cleanups.push(() => socket.terminate())
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    return socket
  }
  const socket = await connect()
  const retry = async (target = socket) => {
    const requestId = randomUUID()
    target.send(JSON.stringify({ type: 'retry_session', request_id: requestId }))
    await expect
      .poll(
        () =>
          messages.find(
            (message) => message.type === 'session_retry' && message.request_id === requestId
          ),
        { timeout: 5000 }
      )
      .toBeDefined()
    return messages.find(
      (message) => message.type === 'session_retry' && message.request_id === requestId
    )
  }
  return {
    ...server,
    workspace,
    worker,
    run,
    sessionId,
    socket,
    connect,
    messages,
    retry,
    ownerPath,
    inputPath,
    historyPath,
    history: readFileSync(historyPath, 'utf8'),
  }
}

test('reports ownership, retries after release, and preserves the original session and history', async () => {
  const ctx = await setup()
  await expect
    .poll(() => ctx.messages)
    .toContainEqual({
      type: 'session_recovery',
      recovery: { kind: 'codex_session_in_use', thread_id: ctx.sessionId },
    })
  expect(await ctx.retry()).toMatchObject({ status: 'still_locked' })
  expect(
    ctx.messages.filter(
      (message) => message.type === 'session_recovery' && message.recovery === null
    )
  ).toEqual([])
  expect(readFileSync(ctx.inputPath, 'utf8')).toBe('r')
  unlinkSync(ctx.ownerPath)
  expect(await ctx.retry()).toMatchObject({ status: 'prompt_cleared' })
  await expect
    .poll(() => ctx.store.getLiveRun(ctx.run.runId).output)
    .toContain(`Original session: ${ctx.sessionId}`)
  expect(ctx.messages.at(-1)).toMatchObject({ type: 'session_retry', status: 'prompt_cleared' })
  expect(ctx.messages).toContainEqual({ type: 'session_recovery', recovery: null })
  expect(ctx.store.listTerminalRuns(ctx.workspace.id)[0]?.thread_id).toBe(ctx.sessionId)
  expect(readFileSync(ctx.historyPath, 'utf8')).toBe(ctx.history)
  // A stale click must not type an r into the now-normal composer.
  expect(await ctx.retry()).toMatchObject({ status: 'not_locked' })
  expect(readFileSync(ctx.inputPath, 'utf8')).toBe('rr')
}, 20000)

test('restores the warning to a second viewer and serializes simultaneous retries', async () => {
  const ctx = await setup()
  const second = await ctx.connect()
  await expect
    .poll(
      () =>
        ctx.messages.filter(
          (message) => message.type === 'session_recovery' && message.recovery !== null
        ).length
    )
    .toBe(2)
  const results = await Promise.all([ctx.retry(), ctx.retry(second)])
  expect(results.map((result) => result?.status).sort()).toEqual(['retry_pending', 'still_locked'])
  expect(readFileSync(ctx.inputPath, 'utf8')).toBe('r')
}, 20000)

test('does not mistake old scrollback for a current ownership screen', async () => {
  const ctx = await setup()
  ctx.store.writeRunInput(ctx.run.runId, 'h')
  await expect.poll(() => ctx.store.getLiveRun(ctx.run.runId).output).toContain('Normal composer')
  expect(await ctx.retry()).toMatchObject({ status: 'not_locked' })
  expect(readFileSync(ctx.inputPath, 'utf8')).toBe('h')
}, 20000)

test('clears restored recovery state when the native keyboard retry succeeds', async () => {
  const ctx = await setup()
  await expect
    .poll(() => ctx.messages)
    .toContainEqual({
      type: 'session_recovery',
      recovery: { kind: 'codex_session_in_use', thread_id: ctx.sessionId },
    })
  unlinkSync(ctx.ownerPath)
  ctx.store.writeRunInput(ctx.run.runId, 'r')
  await expect.poll(() => ctx.messages.at(-1)).toEqual({ type: 'session_recovery', recovery: null })
  expect(readFileSync(ctx.inputPath, 'utf8')).toBe('r')
}, 20000)

test('does not offer Codex recovery for a different CLI even with matching output', async () => {
  const ctx = await setup(false)
  expect(await ctx.retry()).toMatchObject({ status: 'unavailable' })
  expect(
    ctx.messages.some((message) => message.type === 'session_recovery' && message.recovery !== null)
  ).toBe(false)
  expect(readFileSync(ctx.inputPath, 'utf8')).toBe('')
}, 20000)

test('never sends retry input to an exited run', async () => {
  const ctx = await setup()
  ctx.store.writeRunInput(ctx.run.runId, 'q')
  await expect.poll(() => ctx.store.getLiveRun(ctx.run.runId).status).toBe('exited')
  expect(await ctx.retry()).toMatchObject({ status: 'unavailable' })
  expect(readFileSync(ctx.inputPath, 'utf8')).toBe('q')
}, 20000)
