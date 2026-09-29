import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import Database from '../../src/server/sqlite.js'
import { startAuthorizedTestServer as startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

let server: Awaited<ReturnType<typeof startTestServer>>
let directory: string
let workspaceId: string
let agentId: string
let sessionId: string
let logPath: string
let cookie: string
const url = () =>
  `${server.baseUrl}/api/ui/workspaces/${workspaceId}/agents/${agentId}/conversation`
const row = (type: string, payload: object) => `${JSON.stringify({ type, payload })}\n`
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'hive-conversation-'))
  const project = join(directory, '中文 project')
  mkdirSync(project)
  const dataDir = join(directory, 'runtime')
  server = await startTestServer({ dataDir })
  workspaceId = server.store.createWorkspace(project, 'Conversation').id
  agentId = server.store.addWorker(workspaceId, { name: 'Reader', role: 'coder' }).id
  server.store.configureAgentLaunch(workspaceId, agentId, {
    command: 'codex',
    commandPresetId: 'codex',
    sessionIdCapture: {
      source: 'codex_session_jsonl_dir',
      pattern: join(directory, 'native', 'sessions', '**', '*.jsonl'),
    },
  })
  await server.close()
  sessionId = randomUUID()
  const db = new Database(join(dataDir, 'runtime.sqlite'))
  db.prepare(
    'INSERT INTO agent_sessions(workspace_id,agent_id,last_session_id,updated_at) VALUES(?,?,?,?)'
  ).run(workspaceId, agentId, sessionId, Date.now())
  db.close()
  const nativeDir = join(directory, 'native', 'sessions', '2026', '09', '17')
  mkdirSync(nativeDir, { recursive: true })
  logPath = join(nativeDir, `rollout-date-${sessionId}.jsonl`)
  writeFileSync(
    logPath,
    row('session_meta', { id: sessionId, cwd: project }) +
      row('event_msg', { type: 'task_started', turn_id: 'turn-a' }) +
      row('response_item', {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text: '正在检查' }],
      })
  )
  server = await startTestServer({ dataDir })
  cookie = await getUiCookie(server.baseUrl)
})
afterEach(async () => {
  await server.close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

test('reads only the bound native session, refreshes appended answers and preserves the source', async () => {
  const previousStatus = server.store.getWorker(workspaceId, agentId).status
  const first = await fetch(url(), { headers: { cookie } })
  expect(first.status).toBe(200)
  expect(first.headers.get('cache-control')).toBe('no-store')
  expect((await first.json()).turns[0]).toMatchObject({ status: 'running', answer: '' })
  appendFileSync(
    logPath,
    row('response_item', {
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: '最终答案' }],
    }) + row('event_msg', { type: 'task_complete', turn_id: 'turn-a' })
  )
  const source = readFileSync(logPath, 'utf8')
  expect((await (await fetch(url(), { headers: { cookie } })).json()).turns[0]).toMatchObject({
    status: 'complete',
    answer: '最终答案',
    process: [{ kind: 'commentary', text: '正在检查' }],
  })
  expect(server.store.getWorker(workspaceId, agentId).status).toBe(previousStatus)
  expect(readFileSync(logPath, 'utf8')).toBe(source)
})
test('requires UI authentication and rejects a worker from another workspace', async () => {
  expect((await fetch(url())).status).toBe(403)
  const otherPath = join(directory, 'other')
  mkdirSync(otherPath)
  const other = server.store.createWorkspace(otherPath, 'Other')
  expect((await fetch(url().replace(workspaceId, other.id), { headers: { cookie } })).status).toBe(
    404
  )
})
test('does not expose a log with mismatched identity or cwd', async () => {
  for (const header of [
    { id: randomUUID(), cwd: join(directory, '中文 project') },
    { id: sessionId, cwd: directory },
  ]) {
    writeFileSync(
      logPath,
      row('session_meta', header) +
        row('event_msg', { type: 'task_complete', last_agent_message: 'OTHER CONVERSATION' })
    )
    const response = await fetch(url(), { headers: { cookie } })
    expect(await response.json()).toMatchObject({ status: 'pending', turns: [] })
  }
})

test('bounds large histories without losing the last completed answer', async () => {
  const lines = Array.from(
    { length: 24 },
    (_, index) =>
      row('event_msg', { type: 'task_started', turn_id: `large-${index}` }) +
      row('response_item', { type: 'function_call_output', output: 'tool output '.repeat(14000) }) +
      row('response_item', {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: `answer ${index}` }],
      })
  )
  appendFileSync(logPath, lines.join(''))
  const response = await fetch(url(), { headers: { cookie } })
  const body = await response.json()
  expect(response.status).toBe(200)
  expect(body.truncated).toBe(true)
  expect(body.turns.length).toBeLessThanOrEqual(20)
  expect(body.turns.at(-1)).toMatchObject({ status: 'complete', answer: 'answer 23' })
  expect(JSON.stringify(body)).not.toContain('tool output')
})

test('run-scoped reads never attach the last agent session to a persisted run without capture evidence', async () => {
  const runId = randomUUID()
  const db = new Database(join(server.dataDir, 'runtime.sqlite'))
  db.prepare(
    'INSERT INTO agent_runs(run_id,agent_id,status,started_at,created_at,updated_at) VALUES(?,?,?,?,?,?)'
  ).run(runId, agentId, 'exited', Date.now(), Date.now(), Date.now())
  db.close()
  const response = await fetch(`${url()}?run_id=${runId}`, { headers: { cookie } })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ status: 'pending', session_id: null, turns: [] })
  expect((await (await fetch(url(), { headers: { cookie } })).json()).status).toBe('ready')
  expect((await fetch(`${url()}?run_id=${randomUUID()}`, { headers: { cookie } })).status).toBe(404)
})

test('binds real PTY capture and validated resume to their own runs, keeping an unbound new run pending', async () => {
  const scriptPath = join(directory, 'conversation.cjs')
  const nativeRoot = join(directory, 'native')
  writeFileSync(
    scriptPath,
    `
    const {mkdirSync, writeFileSync, existsSync} = require('node:fs');
    const {join} = require('node:path');
    const {randomUUID} = require('node:crypto');
    const root = process.argv.at(-1);
    if (root !== 'wait') {
      const id = /^[a-f0-9-]{36}$/.test(process.argv[2]) ? process.argv[2] : randomUUID();
      const path = join(root, 'sessions', 'rollout-live-' + id + '.jsonl');
      mkdirSync(join(root, 'sessions'), {recursive: true});
      const row = (type, payload) => JSON.stringify({type,payload}) + '\\n';
      if (!existsSync(path)) writeFileSync(path,
        row('session_meta', {id, cwd: process.cwd(), developer_instructions:
          'Hive session binding: workspace_id=' + process.env.HIVE_PROJECT_ID + '; agent_id=' + process.env.HIVE_AGENT_ID}) +
        row('event_msg', {type:'task_started', turn_id:'live'}) +
        row('response_item', {type:'message',role:'assistant',phase:'commentary',content:[{text:'Checking live files'}]}));
      process.stdout.write('SESSION=' + id + '\\r\\n» ');
    } else process.stdout.write('WAITING » ');
    process.stdin.resume();
  `
  )
  const configure = (resume: boolean, wait = false) =>
    server.store.configureAgentLaunch(workspaceId, agentId, {
      command: process.execPath,
      args: [scriptPath, wait ? 'wait' : nativeRoot],
      resumeArgsTemplate: resume ? `${scriptPath} {session_id}` : null,
      sessionIdCapture: {
        source: 'codex_session_jsonl_dir',
        pattern: join(nativeRoot, 'sessions', '**', '*.jsonl'),
      },
    })
  const start = () =>
    server.store.startAgent(workspaceId, agentId, { hivePort: new URL(server.baseUrl).port })
  const read = async (runId: string) => {
    const response = await fetch(`${url()}?run_id=${runId}`, { headers: { cookie } })
    expect(response.status).toBe(200)
    return response.json()
  }
  configure(false)
  const first = await start()
  await expect.poll(async () => (await read(first.runId)).status, { timeout: 8000 }).toBe('ready')
  const publicRun = await (
    await fetch(`${server.baseUrl}/api/runtime/runs/${first.runId}`, { headers: { cookie } })
  ).json()
  expect(publicRun).not.toHaveProperty('sessionContext')
  expect(publicRun).not.toHaveProperty('capture')
  expect(publicRun).not.toHaveProperty('cwd')
  expect(JSON.stringify(publicRun)).not.toContain('codex_session_jsonl_dir')
  const captured = await read(first.runId)
  expect(captured).toMatchObject({
    run_id: first.runId,
    turns: [{ status: 'running', answer: '' }],
  })
  expect(captured.session_id).not.toBe(sessionId)
  const db = new Database(join(server.dataDir, 'runtime.sqlite'))
  try {
    expect(
      db.prepare('SELECT last_session_id FROM agent_sessions WHERE agent_id=?').get(agentId)
    ).toEqual({ last_session_id: captured.session_id })
  } finally {
    db.close()
  }
  const capturedPath = join(nativeRoot, 'sessions', `rollout-live-${captured.session_id}.jsonl`)
  appendFileSync(
    capturedPath,
    row('response_item', {
      type: 'function_call',
      name: 'exec_command',
      call_id: 'call',
      arguments: '{"cmd":"pwd"}',
    }) +
      row('response_item', {
        type: 'function_call_output',
        call_id: 'call',
        output: 'visible output',
      }) +
      row('response_item', {
        type: 'message',
        id: 'first',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ text: 'First conclusion' }],
      }) +
      row('response_item', {
        type: 'message',
        id: 'second',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ text: 'Second conclusion' }],
      }) +
      row('event_msg', {
        type: 'task_complete',
        turn_id: 'live',
        last_agent_message: 'Second conclusion',
      })
  )
  expect((await read(first.runId)).turns[0]).toMatchObject({
    status: 'complete',
    answer: 'First conclusion\n\nSecond conclusion',
  })
  expect((await read(first.runId)).turns[0].process[1].text).toContain('visible output')
  server.store.stopAgentRun(first.runId)
  await expect
    .poll(() => server.store.getLiveRun(first.runId).status, { timeout: 8000 })
    .toBe('exited')
  await expect
    .poll(() => server.store.resources.getSnapshot().occupancy.global, { timeout: 8000 })
    .toBe(0)
  configure(true)
  const resumed = await start()
  expect(await read(resumed.runId)).toMatchObject({
    run_id: resumed.runId,
    status: 'ready',
    session_id: captured.session_id,
  })
  await expect
    .poll(() => server.store.getLiveRun(resumed.runId).output, { timeout: 8000 })
    .toContain('SESSION=')
  server.store.stopAgentRun(resumed.runId)
  await expect
    .poll(() => server.store.getLiveRun(resumed.runId).status, { timeout: 8000 })
    .toBe('exited')
  await expect
    .poll(() => server.store.resources.getSnapshot().occupancy.global, { timeout: 8000 })
    .toBe(0)
  configure(false, true)
  const fresh = await start()
  await expect
    .poll(() => server.store.getLiveRun(fresh.runId).output, { timeout: 8000 })
    .toContain('WAITING')
  expect(await read(fresh.runId)).toMatchObject({
    run_id: fresh.runId,
    status: 'pending',
    session_id: null,
    turns: [],
  })
  expect(await read(first.runId)).toMatchObject({
    run_id: first.runId,
    status: 'ready',
    session_id: captured.session_id,
  })
  const other = server.store.addWorker(workspaceId, { name: 'Other', role: 'reviewer' })
  const response = await fetch(
    `${server.baseUrl}/api/ui/workspaces/${workspaceId}/agents/${other.id}/conversation?run_id=${first.runId}`,
    { headers: { cookie } }
  )
  expect(response.status).toBe(404)
}, 30_000)
