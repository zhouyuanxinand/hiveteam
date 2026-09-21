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
import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test } from 'vitest'
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
