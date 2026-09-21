import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { runGit } from '../../src/server/git-command.js'
import type { CodeReviewContext } from '../../src/shared/code-review.js'
import { startAuthorizedTestServer } from './test-server.js'
import { getUiCookie } from './ui-session.js'

export const commitReviewFixture = async (cwd: string, message: string) => {
  await runGit(cwd, ['add', '.'])
  await runGit(cwd, ['commit', '-m', message])
  return (await runGit(cwd, ['rev-parse', 'HEAD'])).trim()
}

export const createCodeReviewFixture = async (isolated = true) => {
  const root = await mkdtemp(join(tmpdir(), 'hive-code-review-test-'))
  const project = join(root, 'project')
  const dataDir = join(root, 'data')
  await mkdir(project)
  await runGit(project, ['init', '-b', 'main'])
  await runGit(project, ['config', 'core.autocrlf', 'false'])
  await runGit(project, ['config', 'user.name', 'Review Test'])
  await runGit(project, ['config', 'user.email', 'review@example.invalid'])
  await writeFile(join(project, '.gitignore'), '.hive/\n')
  await writeFile(join(project, 'value.txt'), 'original\n')
  const baseline = await commitReviewFixture(project, 'Initial version')
  let server = await startAuthorizedTestServer({ dataDir })
  let closed = false
  const workspace = server.store.createWorkspace(project, 'Code review')
  await server.store.startWorkspaceWatch(workspace.id)
  const worker = server.store.addWorker(workspace.id, { name: 'Builder', role: 'coder' })
  if (isolated) await server.store.worktrees.create(workspace, worker.id)
  server.store.configureAgentLaunch(workspace.id, worker.id, {
    command: process.execPath,
    args: ['-e', 'process.stdin.resume()'],
  })
  const dispatch = await server.store.dispatchTask(workspace.id, worker.id, 'Change the value')
  const sourcePath = server.store.getDispatchWorkspacePath(workspace.id, dispatch.id)
  await writeFile(join(sourcePath, 'value.txt'), 'delivered\n')
  const source = await commitReviewFixture(sourcePath, 'Deliver value')
  server.store.reportTask(workspace.id, worker.id, {
    dispatchId: dispatch.id,
    outcome: 'success',
    text: 'Ready for review',
  })
  let cookie = await getUiCookie(server.baseUrl, server.store)
  const path = `/api/ui/workspaces/${workspace.id}/dispatches/${dispatch.id}/reviews`
  const request = (suffix = '', body?: unknown, headers?: Record<string, string>) =>
    fetch(`${server.baseUrl}${path}${suffix}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(headers ?? { cookie }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return {
    root,
    project,
    dataDir,
    sourcePath,
    baseline,
    source,
    workspace,
    worker,
    dispatch,
    path,
    get server() {
      return server
    },
    get cookie() {
      return cookie
    },
    request,
    async context(): Promise<CodeReviewContext> {
      const response = await request('/context')
      if (!response.ok) throw new Error(await response.text())
      return response.json()
    },
    async restart() {
      await server.close()
      server = await startAuthorizedTestServer({ dataDir })
      cookie = await getUiCookie(server.baseUrl, server.store)
    },
    async closeServer() {
      if (!closed) {
        await server.close()
        closed = true
      }
    },
    async close() {
      if (!closed) {
        await server.close()
        closed = true
      }
      if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}hive-code-review-test-`))
        throw new Error('Unexpected test cleanup path')
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    },
  }
}
