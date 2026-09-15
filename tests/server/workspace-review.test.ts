import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type {
  ReviewDocumentState,
  ReviewDraft,
  ReviewSubmission,
} from '../../src/shared/workspace-review.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

let server: Awaited<ReturnType<typeof startTestServer>>
let directory: string
let workspacePath: string
let id: string
let cookie: string
const request = (suffix: string, method = 'GET', body?: unknown) =>
  fetch(`${server.baseUrl}/api/workspaces/${id}/review${suffix}`, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
const document = async () =>
  (await (await request('/document?path=docs/方案.md')).json()) as ReviewDocumentState
const save = async (content: string, expectedVersion = 0) => {
  const source = await document()
  return request('/draft', 'PUT', {
    path: 'docs/方案.md',
    base_revision: source.document.revision,
    content,
    note: '',
    expected_version: expectedVersion,
  })
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'hive-review-'))
  workspacePath = join(directory, '中文 space')
  mkdirSync(join(workspacePath, 'docs'), { recursive: true })
  writeFileSync(join(workspacePath, 'docs/方案.md'), '# 原型方案\n\n命令行入口。\n')
  server = await startTestServer({ dataDir: join(directory, 'runtime') })
  cookie = await getUiCookie(server.baseUrl)
  id = server.store.createWorkspace(workspacePath, 'Review').id
})
afterEach(async () => {
  await server.close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test('lists and reads workspace Markdown, saves a separate persistent draft and detects concurrent edits', async () => {
  expect(await (await request('/documents')).json()).toEqual({
    paths: ['.hive/tasks.md', 'docs/方案.md'],
    truncated: false,
  })
  expect((await save('# 改为页面入口\n')).status).toBe(200)
  expect(readFileSync(join(workspacePath, 'docs/方案.md'), 'utf8')).toContain('命令行入口')
  expect((await save('stale browser', 0)).status).toBe(409)
  expect((await document()).draft?.content).toBe('# 改为页面入口\n')
  await server.close()
  server = await startTestServer({ dataDir: join(directory, 'runtime') })
  cookie = await getUiCookie(server.baseUrl)
  expect((await document()).draft).toMatchObject({ version: 1, content: '# 改为页面入口\n' })
  const base = await document()
  writeFileSync(join(workspacePath, 'docs/方案.md'), '# Model changed this\n')
  const result = await request('/draft', 'PUT', {
    ...base.draft,
    expected_version: 1,
    note: '',
    content: 'local changes',
  })
  expect(result.status).toBe(409)
  expect((await document()).draft?.content).toBe('# 改为页面入口\n')
})

test('authenticates reads and mutations, rejects traversal, non-Markdown and linked directories', async () => {
  const unauth = await fetch(`${server.baseUrl}/api/workspaces/${id}/review/documents`)
  expect(unauth.status).toBe(403)
  for (const path of [
    '../secret.md',
    'D:/secret.md',
    'docs/../../secret.md',
    '.agents/skills/test.md',
    'docs/file.json',
  ]) {
    expect((await request(`/document?path=${encodeURIComponent(path)}`)).status).toBe(403)
  }
  const outside = join(directory, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.md'), 'private')
  symlinkSync(
    outside,
    join(workspacePath, 'docs/link'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  expect((await request('/document?path=docs/link/secret.md')).status).toBe(403)
  expect((await (await request('/documents')).json()).paths).not.toContain('docs/link/secret.md')
  writeFileSync(join(workspacePath, 'docs/large.md'), 'x'.repeat(64_001))
  expect((await request('/document?path=docs/large.md')).status).toBe(413)
  mkdirSync(join(workspacePath, 'docs/directory.md'))
  expect((await request('/document?path=docs/directory.md')).status).toBe(400)
  writeFileSync(join(workspacePath, 'docs/invalid.md'), Buffer.from([0xff, 0xfe]))
  expect((await request('/document?path=docs/invalid.md')).status).toBe(400)
})

test('confirmation applies only to the exact source version, never overwrites or executes', async () => {
  const state = await document()
  expect(
    (
      await request('/confirm', 'POST', {
        path: state.document.path,
        revision: state.document.revision,
      })
    ).status
  ).toBe(200)
  expect((await document()).confirmed_revision).toBe(state.document.revision)
  await save('different proposal')
  expect(
    (
      await request('/confirm', 'POST', {
        path: state.document.path,
        revision: state.document.revision,
      })
    ).status
  ).toBe(409)
  writeFileSync(join(workspacePath, 'docs/方案.md'), 'new source')
  expect((await document()).confirmed_revision).toBeNull()
  expect(server.store.listTerminalRuns(id)).toEqual([])
})

test('keeps stopped-agent submissions retryable and delivers free text and revision to the real PTY exactly once per request', async () => {
  const answerId = randomUUID()
  const answer = {
    request_id: answerId,
    text: '都不是。\n我希望可以自由编辑。',
    question: 'Q28：入口？',
  }
  const blocked = (await (await request('/answer', 'POST', answer)).json()) as ReviewSubmission
  expect(blocked).toMatchObject({ status: 'blocked', request_id: answerId })
  const script = join(directory, 'echo.mjs')
  const received = join(directory, 'received.txt')
  writeFileSync(received, '')
  writeFileSync(
    script,
    `import { appendFileSync } from 'node:fs';process.stdin.setEncoding('utf8');process.stdin.on('data', text=>{appendFileSync(${JSON.stringify(received)},text);process.stdout.write('RECEIVED:'+text)});setInterval(()=>{},1000)`
  )
  server.store.configureAgentLaunch(id, `${id}:orchestrator`, {
    command: process.execPath,
    args: [script],
  })
  const run = await server.store.startAgent(id, `${id}:orchestrator`, {
    hivePort: new URL(server.baseUrl).port,
  })
  expect((await request('/answer', 'POST', answer)).status).toBe(202)
  await expect
    .poll(async () => (await (await request(`/submissions/${answerId}`)).json()).status)
    .toBe('submitted')
  await expect.poll(() => server.store.getLiveRun(run.runId).output).toContain('自由编辑')
  expect(server.store.getLiveRun(run.runId).output).toContain('Q28')
  const saved = (await (await save('# 原型方案\n\n页面入口。\n')).json()) as ReviewDraft
  const reviewId = randomUUID()
  const input = { request_id: reviewId, path: saved.path, draft_version: saved.version }
  await request('/send', 'POST', input)
  await expect
    .poll(async () => (await (await request(`/submissions/${reviewId}`)).json()).status)
    .toBe('submitted')
  await expect.poll(() => server.store.getLiveRun(run.runId).output).toContain('不是开始实现')
  const output = server.store.getLiveRun(run.runId).output
  expect(output).toContain('base_revision')
  expect(output).toContain('页面入口')
  expect((await (await request('/send', 'POST', input)).json()).status).toBe('submitted')
  // A subsequent acknowledgement is a fence: all earlier input must have reached the real process.
  const fence = { ...answer, request_id: randomUUID(), text: 'delivery-fence' }
  await request('/answer', 'POST', fence)
  await expect.poll(() => readFileSync(received, 'utf8')).toContain('delivery-fence')
  expect(readFileSync(received, 'utf8').split(`[Hive plan review ${reviewId}]`)).toHaveLength(2)
  expect((await request('/answer', 'POST', { ...answer, text: 'different request' })).status).toBe(
    409
  )
  expect(
    (
      await request('/answer', 'POST', {
        ...answer,
        request_id: randomUUID(),
        text: '\u001b[201~malicious',
      })
    ).status
  ).toBe(400)
  expect(readFileSync(join(workspacePath, 'docs/方案.md'), 'utf8')).toContain('命令行入口')
})

test('keeps drafts and submission receipts isolated between workspaces', async () => {
  const firstId = id
  const input = { request_id: randomUUID(), text: 'Private answer', question: '' }
  await request('/answer', 'POST', input)
  await save('Private draft')
  const secondPath = join(directory, 'second workspace')
  mkdirSync(join(secondPath, 'docs'), { recursive: true })
  writeFileSync(join(secondPath, 'docs/方案.md'), '# Other source')
  id = server.store.createWorkspace(secondPath, 'Other').id
  expect((await document()).draft).toBeNull()
  expect((await request(`/submissions/${input.request_id}`)).status).toBe(404)
  id = firstId
  expect((await document()).draft?.content).toBe('Private draft')
  expect((await request(`/submissions/${input.request_id}`)).status).toBe(200)
})

test('an interrupted submission is uncertain after restart and is never automatically replayed', async () => {
  const input = { request_id: randomUUID(), text: 'Do not replay blindly', question: '' }
  await request('/answer', 'POST', input)
  await server.close()
  const db = new Database(join(directory, 'runtime/runtime.sqlite'))
  db.prepare("UPDATE workspace_review_submissions SET status = 'sending' WHERE request_id = ?").run(
    input.request_id
  )
  db.close()
  server = await startTestServer({ dataDir: join(directory, 'runtime') })
  cookie = await getUiCookie(server.baseUrl)
  expect(await (await request(`/submissions/${input.request_id}`)).json()).toMatchObject({
    status: 'uncertain',
  })
  expect(await (await request('/answer', 'POST', input)).json()).toMatchObject({
    status: 'uncertain',
  })
  expect(server.store.listTerminalRuns(id)).toEqual([])
})

test('sends complete bounded documents without truncating escaped JSON or diff content', async () => {
  const source = `# source\n${'\t\n'.repeat(30_000)}`
  const proposal = `# proposal\n${'\n\t'.repeat(30_000)}END-OF-PROPOSAL`
  writeFileSync(join(workspacePath, 'docs/方案.md'), source)
  const saved = (await (await save(proposal)).json()) as ReviewDraft
  const request_id = randomUUID()
  expect(
    (await request('/send', 'POST', { request_id, path: saved.path, draft_version: saved.version }))
      .status
  ).toBe(202)
  const db = new Database(join(directory, 'runtime/runtime.sqlite'), { readonly: true })
  try {
    const row = db
      .prepare('SELECT payload FROM workspace_review_submissions WHERE request_id = ?')
      .get(request_id) as { payload: string }
    const json = row.payload.slice(row.payload.indexOf('{'), row.payload.lastIndexOf('}') + 1)
    expect(JSON.parse(json)).toMatchObject({ base_content: source, proposed_content: proposal })
    expect(JSON.parse(json).diff).toContain('END-OF-PROPOSAL')
  } finally {
    db.close()
  }
})
