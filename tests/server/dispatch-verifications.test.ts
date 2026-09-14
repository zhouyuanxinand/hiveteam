import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { runGit } from '../../src/server/git-command.js'
import { openRuntimeDatabase } from '../../src/server/runtime-database.js'
import { createVerificationStore } from '../../src/server/verification-store.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []
const roots: string[] = []
afterEach(async () => {
  while (servers.length) await servers.pop()?.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-verification-test-'))
  roots.push(root)
  const project = join(root, 'project')
  mkdirSync(project)
  await runGit(project, ['init', '-b', 'main'])
  await runGit(project, ['config', 'user.name', 'Delivery Test'])
  await runGit(project, ['config', 'user.email', 'delivery@example.com'])
  writeFileSync(join(project, 'value.txt'), 'original')
  writeFileSync(
    join(project, 'check.cjs'),
    `const fs = require('node:fs'); if (fs.readFileSync('value.txt', 'utf8') !== 'original') process.exit(7); console.log('CHECK PASSED'); console.log(process.cwd());`
  )
  writeFileSync(join(project, 'wait.cjs'), `console.log('WAITING'); setInterval(() => {}, 1000)`)
  writeFileSync(
    join(project, 'mutate.cjs'),
    `require('node:fs').writeFileSync('value.txt', 'changed'); console.log('CHANGED')`
  )
  writeFileSync(join(project, 'fail.cjs'), `console.error('CHECK FAILED'); process.exit(3)`)
  writeFileSync(join(project, 'large.cjs'), `process.stdout.write('x'.repeat(100000))`)
  await runGit(project, ['add', '.'])
  await runGit(project, ['commit', '-m', 'Add verification fixtures'])
  const head = (await runGit(project, ['rev-parse', 'HEAD'])).trim()
  const dataDir = join(root, 'data')
  const server = await startTestServer({ dataDir })
  servers.push(server)
  const workspace = server.store.createWorkspace(project, 'Verification')
  await server.store.startWorkspaceWatch(workspace.id)
  const worker = server.store.addWorker(workspace.id, { name: 'Builder', role: 'coder' })
  server.store.configureAgentLaunch(workspace.id, worker.id, {
    command: process.execPath,
    args: ['-e', 'process.stdin.resume()'],
  })
  await server.store.startAgent(workspace.id, worker.id, { hivePort: new URL(server.baseUrl).port })
  const dispatch = await server.store.dispatchTask(workspace.id, worker.id, 'Deliver the fixture')
  server.store.reportTask(workspace.id, worker.id, {
    dispatchId: dispatch.id,
    outcome: 'success',
    text: 'Ready for verification',
  })
  const cookie = await getUiCookie(server.baseUrl)
  const path = `/api/ui/workspaces/${workspace.id}/dispatches/${dispatch.id}`
  const request = (suffix: string, body?: unknown, authenticated = true) =>
    fetch(`${server.baseUrl}${path}${suffix}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(authenticated ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const start = (command = 'node check.cjs', revision = 1, headSha = head) =>
    request('/verifications', { command, report_revision: revision, head_sha: headSha })
  const done = async () => {
    await vi.waitFor(
      async () => {
        const body = await (await request('/verifications')).json()
        expect(body.runs[0]?.state).not.toBe('running')
        expect(body.runs[0]?.ended_at).toEqual(expect.any(Number))
      },
      { timeout: 15_000 }
    )
    return (await request('/verifications')).json()
  }
  return {
    server,
    project,
    dataDir,
    workspace,
    worker,
    dispatch,
    cookie,
    path,
    head,
    request,
    start,
    done,
  }
}

describe('version-bound dispatch verification', () => {
  test('rehydrates an unfinished stored run as interrupted without accepting it', async () => {
    const ctx = await setup()
    await servers.pop()?.close()
    const db = openRuntimeDatabase(ctx.dataDir)
    try {
      createVerificationStore(db).insert({
        id: randomUUID(),
        workspaceId: ctx.workspace.id,
        dispatchId: ctx.dispatch.id,
        reportRevision: 1,
        headSha: ctx.head,
        command: 'node wait.cjs',
        state: 'running',
        output: '',
        outputTruncated: false,
        exitCode: null,
        error: null,
        startedAt: Date.now(),
        endedAt: null,
        acceptedAt: null,
      })
    } finally {
      db.close()
    }
    const restarted = await startTestServer({ dataDir: ctx.dataDir })
    servers.push(restarted)
    const view = await restarted.store.verifications.view(ctx.workspace.id, ctx.dispatch.id)
    expect(view).toMatchObject({ accepted: false, canAccept: false })
    expect(view.runs[0]).toMatchObject({
      state: 'interrupted',
      exitCode: null,
      acceptedAt: null,
      endedAt: expect.any(Number),
    })
  })

  test('bounds persisted command output without losing its exit status', async () => {
    const ctx = await setup()
    expect((await ctx.start('node large.cjs')).status).toBe(202)
    const result = await ctx.done()
    expect(result.runs[0]).toMatchObject({ state: 'passed', exit_code: 0, output_truncated: true })
    expect(result.runs[0].output).toBe('x'.repeat(64 * 1024))
  })
  test('runs a real command in a detached checkout, persists evidence and authenticated acceptance', async () => {
    const ctx = await setup()
    expect((await ctx.request('/verifications', undefined, false)).status).toBe(403)
    const response = await ctx.start()
    expect(response.status).toBe(202)
    const started = await response.json()
    const result = await ctx.done()
    expect(result).toMatchObject({ can_accept: true, accepted: false, stale_reason: null })
    expect(result.runs[0]).toMatchObject({
      state: 'passed',
      head_sha: ctx.head,
      report_revision: 1,
      exit_code: 0,
      error: null,
    })
    expect(result.runs[0].output).toContain('CHECK PASSED')
    expect(result.runs[0].output).toContain('verification-worktrees')
    expect(result.runs[0].output).not.toContain(ctx.project)
    expect(
      (await runGit(ctx.project, ['worktree', 'list', '--porcelain'])).match(/^worktree /gm)
    ).toHaveLength(1)
    expect((await runGit(ctx.project, ['rev-parse', 'HEAD'])).trim()).toBe(ctx.head)
    const acceptPath = `/verifications/${started.id}/accept`
    expect((await ctx.request(acceptPath, {}, false)).status).toBe(403)
    const accepted = await (await ctx.request(acceptPath, {})).json()
    expect(accepted.accepted).toBe(true)
    expect(ctx.server.store.getDispatch(ctx.workspace.id, ctx.dispatch.id)?.acceptedAt).toEqual(
      expect.any(Number)
    )
    const timestamp = accepted.runs[0].accepted_at
    expect((await (await ctx.request(acceptPath, {})).json()).runs[0].accepted_at).toBe(timestamp)
    await servers.pop()?.close()
    const restarted = await startTestServer({ dataDir: ctx.dataDir })
    servers.push(restarted)
    const persisted = await restarted.store.verifications.view(ctx.workspace.id, ctx.dispatch.id)
    expect(persisted.accepted).toBe(true)
    expect(persisted.runs[0]).toMatchObject({ acceptedAt: timestamp, exitCode: 0, state: 'passed' })
  })

  test('a failed rerun supersedes a previous pass and cannot be accepted', async () => {
    const ctx = await setup()
    const first = await (await ctx.start()).json()
    await ctx.done()
    await ctx.request(`/verifications/${first.id}/accept`, {})
    expect((await ctx.start('node fail.cjs')).status).toBe(202)
    const failed = await ctx.done()
    expect(failed).toMatchObject({ accepted: false, can_accept: false })
    expect(failed.runs[0]).toMatchObject({ state: 'failed', exit_code: 3 })
    expect(failed.runs[0].output).toContain('CHECK FAILED')
    expect((await ctx.request(`/verifications/${first.id}/accept`, {})).status).toBe(409)
    expect((await ctx.request(`/verifications/${failed.runs[0].id}/accept`, {})).status).toBe(409)
  })

  test('dirty files, new commits, and revised reports invalidate current acceptance', async () => {
    const ctx = await setup()
    const first = await (await ctx.start()).json()
    await ctx.done()
    await ctx.request(`/verifications/${first.id}/accept`, {})
    writeFileSync(join(ctx.project, 'extra.txt'), 'new code')
    expect(await (await ctx.request('/verifications')).json()).toMatchObject({
      accepted: false,
      can_run: false,
      stale_reason: 'uncommitted_changes',
    })
    expect((await ctx.start()).status).toBe(409)
    expect((await ctx.request(`/verifications/${first.id}/accept`, {})).status).toBe(409)
    await runGit(ctx.project, ['add', 'extra.txt'])
    await runGit(ctx.project, ['commit', '-m', 'Add another change'])
    expect(await (await ctx.request('/verifications')).json()).toMatchObject({
      stale_reason: 'code_changed',
      accepted: false,
    })
    const nextHead = (await runGit(ctx.project, ['rev-parse', 'HEAD'])).trim()
    expect((await ctx.start('node check.cjs', 1, nextHead)).status).toBe(202)
    const second = await ctx.done()
    expect((await ctx.request('/feedback', { text: 'Revise the implementation' })).status).toBe(202)
    ctx.server.store.reportTask(ctx.workspace.id, ctx.worker.id, {
      dispatchId: ctx.dispatch.id,
      outcome: 'success',
      text: 'Revised report',
    })
    expect(await (await ctx.request('/verifications')).json()).toMatchObject({
      report_revision: 2,
      stale_reason: 'report_changed',
      accepted: false,
    })
    expect((await ctx.request(`/verifications/${second.runs[0].id}/accept`, {})).status).toBe(409)
  })

  test('a command that modifies its checkout cannot pass and leaves the source intact', async () => {
    const ctx = await setup()
    expect((await ctx.start('node mutate.cjs')).status).toBe(202)
    const result = await ctx.done()
    expect(result.runs[0]).toMatchObject({ state: 'failed', exit_code: 0 })
    expect(result.runs[0].error).toContain('changed checkout')
    expect(readFileSync(join(ctx.project, 'value.txt'), 'utf8')).toBe('original')
    expect((await runGit(ctx.project, ['diff', 'HEAD'])).trim()).toBe('')
  })

  test('cancels a live process, rejects overlapping runs, and removes the temporary checkout', async () => {
    const ctx = await setup()
    const started = await (await ctx.start('node wait.cjs')).json()
    await vi.waitFor(
      async () =>
        expect((await (await ctx.request('/verifications')).json()).runs[0].output).toContain(
          'WAITING'
        ),
      { timeout: 10_000 }
    )
    expect((await ctx.start()).status).toBe(409)
    expect((await ctx.request(`/verifications/${started.id}/cancel`, {})).status).toBe(200)
    const result = await ctx.done()
    expect(result.runs[0].state).toBe('cancelled')
    expect(result.can_accept).toBe(false)
    expect(
      (await runGit(ctx.project, ['worktree', 'list', '--porcelain'])).match(/^worktree /gm)
    ).toHaveLength(1)
  })
})
