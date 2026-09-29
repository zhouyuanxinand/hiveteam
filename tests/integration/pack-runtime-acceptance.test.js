import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import {
  installedRuntimeAcceptance,
  verifyInstalledRestart,
} from '../../scripts/pack-runtime-acceptance.mjs'
import { startTestServer } from '../helpers/test-server.js'

let server
let root
afterEach(async () => {
  await server?.close()
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test('runtime acceptance records real terminal, stop and restart evidence', async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hive-release 中文 ')))
  const workspacePath = join(root, '项目 空格')
  mkdirSync(workspacePath)
  const dataDir = join(root, 'data')
  server = await startTestServer({ dataDir })
  const sessionCookie = async () => {
    const response = await fetch(`${server.baseUrl}/api/ui/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bootstrap_token: server.store.createUiBootstrap() }),
    })
    expect(response.status).toBe(200)
    return response.headers.get('set-cookie').split(';')[0]
  }
  let cookie = await sessionCookie()
  const response = await fetch(`${server.baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      path: workspacePath,
      name: 'Release 中文',
      initialization_mode: 'basic',
      autostart_orchestrator: false,
    }),
  })
  expect(response.status).toBe(201)
  const receipt = await installedRuntimeAcceptance({
    baseUrl: server.baseUrl,
    cookie,
    packageRoot: resolve('.'),
    tempDir: root,
    workspace: await response.json(),
    bootstrap: () => server.store.createUiBootstrap(),
    root: resolve('.'),
  })
  expect(receipt.checks.ws_unicode_input.status).toBe('passed')
  expect(receipt.checks.pty_resize.observed_sizes).toEqual([
    { cols: 101, rows: 31 },
    { cols: 113, rows: 37 },
  ])
  expect(receipt.checks.stop_lifecycle).toMatchObject({
    status: 'passed',
    occupancy_before: 2,
    occupancy_after: 0,
  })
  await server.close()
  server = undefined
  server = await startTestServer({ dataDir })
  cookie = await sessionCookie()
  const restarted = await verifyInstalledRestart(server.baseUrl, cookie, receipt)
  expect(restarted.checks.sqlite_restart).toMatchObject({
    status: 'passed',
    workspace_path: workspacePath,
    dispatch_id: receipt.dispatch_id,
  })
}, 60000)
