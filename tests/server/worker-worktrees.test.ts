import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { runGit } from '../../src/server/git-command.js'
import { openRuntimeDatabase } from '../../src/server/runtime-database.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []
const roots: string[] = []
afterEach(async () => {
  while (servers.length) await servers.pop()?.close()
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}hive-worktree-test-`))
      throw new Error('Unexpected test cleanup path')
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}
const head = async (path: string) => (await runGit(path, ['rev-parse', 'HEAD'])).trim()
const commit = async (path: string, message: string) => {
  await runGit(path, ['add', '.'])
  await runGit(path, ['commit', '-m', message])
  return head(path)
}
const setup = async (subdirectory = false) => {
  const root = mkdtempSync(join(tmpdir(), 'hive-worktree-test-'))
  roots.push(root)
  const project = join(root, 'project')
  mkdirSync(project)
  await runGit(project, ['init', '-b', 'main'])
  await runGit(project, ['config', 'user.name', 'Delivery Test'])
  await runGit(project, ['config', 'user.email', 'delivery@example.com'])
  writeFileSync(join(project, '.gitignore'), '*.runtime\n')
  const scope = subdirectory ? join(project, 'package') : project
  mkdirSync(scope, { recursive: true })
  writeFileSync(join(scope, 'value.txt'), 'original')
  writeFileSync(
    join(scope, 'agent.cjs'),
    `require('node:fs').writeFileSync('session.runtime', JSON.stringify({cwd:process.cwd(), worker:process.env.HIVE_AGENT_ID, workspace:process.env.HIVE_PROJECT_ID})); process.stdin.resume()`
  )
  writeFileSync(
    join(scope, 'check.cjs'),
    `if(require('node:fs').readFileSync('value.txt','utf8') !== 'delivered') process.exit(7); console.log('ISOLATED CHECK PASSED')`
  )
  const baseline = await commit(project, 'Initial project')
  const dataDir = join(root, 'data')
  const server = await startTestServer({ dataDir })
  servers.push(server)
  const workspace = server.store.createWorkspace(scope, 'Isolated delivery')
  await server.store.startWorkspaceWatch(workspace.id)
  const cookie = await getUiCookie(server.baseUrl)
  const request = (path: string, body?: unknown, authenticated = true) =>
    fetch(`${server.baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(authenticated ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const workerPath = `/api/workspaces/${workspace.id}/workers`
  const create = async (name: string) => {
    const response = await request(workerPath, {
      name,
      role: 'coder',
      isolated: true,
      startup_command: `"${process.execPath}" agent.cjs`,
      autostart: false,
    })
    const body = await response.json()
    expect(body.error).toBeUndefined()
    expect(response.status).toBe(201)
    expect(body.agent_start.error).toBeNull()
    const tree = server.store.worktrees.get(workspace.id, body.id)
    if (!tree) throw new Error('Expected isolated worktree')
    expect(body).toMatchObject({
      worktree_branch: tree.branch,
      working_directory: tree.workspacePath,
    })
    return { id: body.id as string, tree }
  }
  const deliver = async () => {
    const worker = await create('Builder')
    const dispatch = await server.store.dispatchTask(workspace.id, worker.id, 'Deliver a change')
    writeFileSync(join(worker.tree.workspacePath, 'value.txt'), 'delivered')
    const sha = await commit(worker.tree.checkoutPath, 'Deliver change')
    server.store.reportTask(workspace.id, worker.id, {
      dispatchId: dispatch.id,
      outcome: 'success',
      text: 'Ready',
    })
    const path = `/api/ui/workspaces/${workspace.id}/dispatches/${dispatch.id}`
    const verify = async () => {
      const started = await request(`${path}/verifications`, {
        command: 'node check.cjs',
        head_sha: sha,
        report_revision: 1,
      })
      expect(started.status).toBe(202)
      const run = await started.json()
      await vi.waitFor(
        async () => {
          const view = await (await request(`${path}/verifications`)).json()
          expect(view.runs[0].state).toBe('passed')
          expect(view.runs[0].output).toContain('ISOLATED CHECK PASSED')
        },
        { timeout: 20_000 }
      )
      expect((await request(`${path}/verifications/${run.id}/accept`, {})).status).toBe(200)
      return run.id as string
    }
    const integration = () => request(`${path}/integration`)
    const integrate = (
      view: { source_sha: string; target_sha: string; verification_id: string },
      auth = true
    ) =>
      request(
        `${path}/integration`,
        {
          source_sha: view.source_sha,
          target_sha: view.target_sha,
          verification_id: view.verification_id,
        },
        auth
      )
    return { worker, dispatch, path, sha, verify, integration, integrate }
  }
  return {
    root,
    project,
    scope,
    dataDir,
    server,
    workspace,
    baseline,
    cookie,
    request,
    create,
    deliver,
    workerPath,
  }
}

describe('isolated worker delivery', () => {
  test('persists preparation errors and keeps the failed worker stopped', async () => {
    const ctx = await setup()
    const worktrees = join(ctx.dataDir, 'worker-worktrees')
    mkdirSync(worktrees)
    writeFileSync(join(worktrees, 'empty-hooks'), 'Blocks directory creation')
    const response = await ctx.request(ctx.workerPath, {
      name: 'Builder',
      role: 'coder',
      isolated: true,
      startup_command: `"${process.execPath}" agent.cjs`,
      autostart: true,
    })
    expect(response.status).toBe(201)
    const worker = await response.json()
    expect(worker.agent_start).toMatchObject({ ok: false, run_id: null })
    expect(worker.agent_start.error).toContain('empty-hooks')
    expect(ctx.server.store.worktrees.get(ctx.workspace.id, worker.id)).toMatchObject({
      state: 'failed',
      error: worker.agent_start.error,
    })
    expect(ctx.server.store.getWorker(ctx.workspace.id, worker.id).status).toBe('stopped')
    expect(ctx.server.store.listWorkers(ctx.workspace.id)[0]?.worktreeError).toBe(
      worker.agent_start.error
    )
    expect(ctx.server.store.getActiveRunByAgentId(ctx.workspace.id, worker.id)).toBeUndefined()
    expect(existsSync(join(ctx.project, 'session.runtime'))).toBe(false)
    expect(await head(ctx.project)).toBe(ctx.baseline)
  }, 60_000)

  test('concurrent creation never leaves an unisolated worker after a rejected request', async () => {
    const ctx = await setup()
    const responses = await Promise.all(
      ['First', 'Second'].map((name) =>
        ctx.request(ctx.workerPath, { name, role: 'coder', isolated: true })
      )
    )
    expect(responses.every((response) => [201, 409].includes(response.status))).toBe(true)
    const created = responses.filter((response) => response.status === 201)
    expect(created.length).toBeGreaterThan(0)
    const workers = ctx.server.store.listWorkers(ctx.workspace.id)
    expect(workers).toHaveLength(created.length)
    for (const worker of workers) {
      expect(worker.workingDirectory).toContain('worker-worktrees')
      expect(ctx.server.store.worktrees.get(ctx.workspace.id, worker.id)?.state).toBe('ready')
    }
  }, 60_000)

  test('interrupted preparation remains visible and cannot start a shared-directory PTY', async () => {
    const ctx = await setup()
    const worker = await ctx.create('Builder')
    await servers.pop()?.close()
    const db = openRuntimeDatabase(ctx.dataDir)
    try {
      db.prepare("UPDATE worker_worktrees SET state = 'preparing' WHERE worker_id = ?").run(
        worker.id
      )
    } finally {
      db.close()
    }
    const restarted = await startTestServer({ dataDir: ctx.dataDir })
    servers.push(restarted)
    expect(restarted.store.worktrees.get(ctx.workspace.id, worker.id)).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('interrupted'),
      workspacePath: worker.tree.workspacePath,
    })
    expect(restarted.store.listWorkers(ctx.workspace.id)[0]?.worktreeError).toContain('interrupted')
    await expect(
      restarted.store.startAgent(ctx.workspace.id, worker.id, {
        hivePort: new URL(restarted.baseUrl).port,
      })
    ).rejects.toThrow('preparation was interrupted')
    expect(restarted.store.getWorker(ctx.workspace.id, worker.id).status).toBe('stopped')
    expect(existsSync(join(ctx.project, 'session.runtime'))).toBe(false)
    expect(await head(worker.tree.checkoutPath)).toBe(ctx.baseline)
  }, 60_000)
  test('real PTYs use separate persisted worktrees, including a workspace subdirectory', async () => {
    const ctx = await setup(true)
    const first = await ctx.create('First')
    const second = await ctx.create('Second')
    const runs = await Promise.all(
      [first, second].map((worker) =>
        ctx.server.store.startAgent(ctx.workspace.id, worker.id, {
          hivePort: new URL(ctx.server.baseUrl).port,
        })
      )
    )
    for (const worker of [first, second]) {
      await vi.waitFor(() =>
        expect(existsSync(join(worker.tree.workspacePath, 'session.runtime'))).toBe(true)
      )
      expect(
        JSON.parse(readFileSync(join(worker.tree.workspacePath, 'session.runtime'), 'utf8'))
      ).toEqual({
        cwd: worker.tree.workspacePath,
        worker: worker.id,
        workspace: ctx.workspace.id,
      })
    }
    expect(first.tree.workspacePath).not.toBe(second.tree.workspacePath)
    expect(existsSync(join(ctx.scope, 'session.runtime'))).toBe(false)
    expect(await head(ctx.project)).toBe(ctx.baseline)
    expect(runs.map((run) => run.status)).not.toContain('error')
    const pids = runs.map((run) => {
      if (!run.pid) throw new Error('Expected a real PTY process')
      expect(isProcessAlive(run.pid)).toBe(true)
      return run.pid
    })
    await servers.pop()?.close()
    for (const pid of pids) expect(isProcessAlive(pid)).toBe(false)
    const restarted = await startTestServer({ dataDir: ctx.dataDir })
    servers.push(restarted)
    expect(restarted.store.worktrees.get(ctx.workspace.id, first.id)).toEqual(first.tree)
    rmSync(join(first.tree.workspacePath, 'session.runtime'))
    const resumed = await restarted.store.dispatchTask(
      ctx.workspace.id,
      first.id,
      'Continue isolated work',
      {
        fromAgentId: `${ctx.workspace.id}:orchestrator`,
        hivePort: new URL(restarted.baseUrl).port,
      }
    )
    expect(resumed.status).toBe('submitted')
    await vi.waitFor(() =>
      expect(existsSync(join(first.tree.workspacePath, 'session.runtime'))).toBe(true)
    )
    expect(
      JSON.parse(readFileSync(join(first.tree.workspacePath, 'session.runtime'), 'utf8')).cwd
    ).toBe(first.tree.workspacePath)
    expect(
      restarted.store.listWorkers(ctx.workspace.id).find((worker) => worker.id === first.id)
        ?.workingDirectory
    ).toBe(first.tree.workspacePath)
    const resumedRun = restarted.store.getActiveRunByAgentId(ctx.workspace.id, first.id)
    if (!resumedRun?.pid) throw new Error('Expected a resumed PTY process')
    expect(isProcessAlive(resumedRun.pid)).toBe(true)
    await servers.pop()?.close()
    expect(isProcessAlive(resumedRun.pid)).toBe(false)
  }, 60_000)

  test('verifies isolated changes, reviews a real diff, then fast-forwards only the accepted version', async () => {
    const ctx = await setup()
    const task = await ctx.deliver()
    expect(task.dispatch.baseHeadSha).toBe(ctx.baseline)
    const diff = await (await ctx.request(`${task.path}/diff`)).json()
    expect(diff.patch).toContain('+delivered')
    expect(diff.head_sha).toBe(task.sha)
    writeFileSync(join(ctx.project, 'value.txt'), 'local edit')
    await task.verify()
    expect(await (await task.integration()).json()).toMatchObject({
      can_integrate: false,
      reason: 'target_dirty',
    })
    writeFileSync(join(ctx.project, 'value.txt'), 'original')
    const preview = await (await task.integration()).json()
    expect(preview).toMatchObject({
      can_integrate: true,
      source_sha: task.sha,
      target_sha: ctx.baseline,
    })
    expect(preview.patch).toContain('+delivered')
    expect(await head(ctx.project)).toBe(ctx.baseline)
    expect((await task.integrate(preview, false)).status).toBe(403)
    const response = await task.integrate(preview)
    expect(response.status).toBe(200)
    const integrated = await response.json()
    expect(integrated.integrated_at).toEqual(expect.any(Number))
    expect(await head(ctx.project)).toBe(task.sha)
    expect(readFileSync(join(ctx.project, 'value.txt'), 'utf8')).toBe('delivered')
    expect((await (await task.integrate(integrated)).json()).integrated_at).toBe(
      integrated.integrated_at
    )
    expect(await head(task.worker.tree.checkoutPath)).toBe(task.sha)
    await servers.pop()?.close()
    const restarted = await startTestServer({ dataDir: ctx.dataDir })
    servers.push(restarted)
    expect(
      (await restarted.store.integrations.view(ctx.workspace.id, task.dispatch.id)).integratedAt
    ).toBe(integrated.integrated_at)
  }, 60_000)

  test('rejects stale previews, changed sources, unaccepted results, and target divergence', async () => {
    const ctx = await setup()
    const task = await ctx.deliver()
    const unaccepted = await (await task.integration()).json()
    expect(unaccepted.reason).toBe('accept_required')
    await task.verify()
    const preview = await (await task.integration()).json()
    writeFileSync(join(task.worker.tree.workspacePath, 'value.txt'), 'new edits')
    expect((await task.integrate(preview)).status).toBe(409)
    writeFileSync(join(task.worker.tree.workspacePath, 'value.txt'), 'delivered')
    writeFileSync(join(ctx.project, 'another.txt'), 'parallel change')
    const target = await commit(ctx.project, 'Parallel change')
    expect((await task.integrate(preview)).status).toBe(409)
    expect(await (await task.integration()).json()).toMatchObject({
      can_integrate: false,
      reason: 'target_diverged',
      target_sha: target,
    })
    expect(await head(ctx.project)).toBe(target)
    expect(readFileSync(join(ctx.project, 'value.txt'), 'utf8')).toBe('original')
    expect((await runGit(ctx.project, ['status', '--porcelain'])).includes('UU')).toBe(false)
  }, 60_000)

  test('blocks integration during a live source PTY and preserves output when the worker is deleted', async () => {
    const ctx = await setup()
    const task = await ctx.deliver()
    await task.verify()
    await ctx.server.store.startAgent(ctx.workspace.id, task.worker.id, {
      hivePort: new URL(ctx.server.baseUrl).port,
    })
    const preview = await (await task.integration()).json()
    expect(preview.reason).toBe('agents_running')
    expect((await task.integrate(preview)).status).toBe(409)
    ctx.server.store.deleteWorker(ctx.workspace.id, task.worker.id)
    expect(existsSync(join(task.worker.tree.workspacePath, 'value.txt'))).toBe(true)
    expect(await head(task.worker.tree.checkoutPath)).toBe(task.sha)
    expect(await head(ctx.project)).toBe(ctx.baseline)
  }, 60_000)

  test('rejects dirty creation and changed worktree branches without falling back to the shared directory', async () => {
    const ctx = await setup()
    const body = { name: 'Blocked', role: 'coder', isolated: true }
    expect((await ctx.request(ctx.workerPath, body, false)).status).toBe(403)
    writeFileSync(join(ctx.project, 'value.txt'), 'uncommitted')
    expect((await ctx.request(ctx.workerPath, body)).status).toBe(409)
    expect(ctx.server.store.listWorkers(ctx.workspace.id)).toHaveLength(0)
    writeFileSync(join(ctx.project, 'value.txt'), 'original')
    const worker = await ctx.create('Builder')
    await runGit(worker.tree.checkoutPath, ['checkout', '--detach'])
    await expect(
      ctx.server.store.startAgent(ctx.workspace.id, worker.id, {
        hivePort: new URL(ctx.server.baseUrl).port,
      })
    ).rejects.toThrow('branch changed')
    expect(ctx.server.store.getWorker(ctx.workspace.id, worker.id).status).toBe('stopped')
    expect(existsSync(join(ctx.project, 'session.runtime'))).toBe(false)
  }, 60_000)
})
