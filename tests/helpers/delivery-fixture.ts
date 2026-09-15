import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { expect, vi } from 'vitest'
import { runGit } from '../../src/server/git-command.js'
import type { GitHubClient } from '../../src/server/github-pull-requests.js'
import { startTestServer } from './test-server.js'
import { getUiCookie } from './ui-session.js'

export const gitHead = async (cwd: string) => (await runGit(cwd, ['rev-parse', 'HEAD'])).trim()
export const commitDelivery = async (cwd: string, message: string) => {
  await runGit(cwd, ['add', '.'])
  await runGit(cwd, ['commit', '-m', message])
  return gitHead(cwd)
}
export const createDeliveryFixture = async (github?: GitHubClient) => {
  const root = mkdtempSync(join(tmpdir(), 'hive-delivery-test-'))
  const project = join(root, 'project')
  const bare = join(root, 'remote.git')
  mkdirSync(project)
  await runGit(project, ['init', '-b', 'main'])
  await runGit(project, ['config', 'user.name', 'Delivery Test'])
  await runGit(project, ['config', 'user.email', 'delivery@example.com'])
  writeFileSync(join(project, 'value.txt'), 'initial')
  writeFileSync(
    join(project, 'check.cjs'),
    "if(require('node:fs').readFileSync('value.txt','utf8') !== 'delivered') process.exit(7); console.log('DELIVERY PASSED')"
  )
  const baseline = await commitDelivery(project, 'Initial project')
  await runGit(project, ['init', '--bare', bare])
  await runGit(project, ['remote', 'add', 'origin', 'https://github.com/example/delivery.git'])
  await runGit(project, [
    'config',
    `url.${bare.replaceAll('\\', '/')}.insteadOf`,
    'https://github.com/example/delivery.git',
  ])
  await runGit(project, ['push', 'origin', 'main'])
  const dataDir = join(root, 'data')
  let server = await startTestServer({ dataDir, ...(github ? { github } : {}) })
  const workspace = server.store.createWorkspace(project, 'Delivery example')
  let cookie = await getUiCookie(server.baseUrl)
  const request = (path: string, body?: unknown, authenticated = true) =>
    fetch(server.baseUrl + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(authenticated ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const createWorker = async (name = 'Builder') => {
    const worker = server.store.addWorker(workspace.id, { name, role: 'coder' })
    const tree = await server.store.worktrees.create(workspace, worker.id)
    return { worker, tree }
  }
  const deliver = async () => {
    const { worker, tree } = await createWorker()
    const dispatch = await server.store.dispatchTask(workspace.id, worker.id, 'Deliver the change')
    writeFileSync(join(tree.workspacePath, 'value.txt'), 'delivered')
    const sha = await commitDelivery(tree.checkoutPath, 'Deliver change')
    server.store.reportTask(workspace.id, worker.id, {
      dispatchId: dispatch.id,
      outcome: 'success',
      text: 'Ready for review',
    })
    const path = `/api/ui/workspaces/${workspace.id}/dispatches/${dispatch.id}`
    const verify = async () => {
      const response = await request(`${path}/verifications`, {
        command: 'node check.cjs',
        head_sha: sha,
        report_revision: 1,
      })
      expect(response.status).toBe(202)
      const run = await response.json()
      await vi.waitFor(
        async () => {
          const result = await (await request(`${path}/verifications`)).json()
          expect(result.runs[0]).toMatchObject({
            state: 'passed',
            output: expect.stringContaining('DELIVERY PASSED'),
          })
        },
        { timeout: 20_000 }
      )
      expect((await request(`${path}/verifications/${run.id}/accept`, {})).status).toBe(200)
      return String(run.id)
    }
    return { worker, tree, dispatch, sha, path, verify }
  }
  return {
    root,
    project,
    bare,
    baseline,
    dataDir,
    workspace,
    request,
    createWorker,
    deliver,
    get server() {
      return server
    },
    async restart() {
      await server.close()
      server = await startTestServer({ dataDir, ...(github ? { github } : {}) })
      cookie = await getUiCookie(server.baseUrl)
    },
    async close() {
      await server.close()
      if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}hive-delivery-test-`))
        throw new Error('Unexpected cleanup path')
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    },
  }
}
