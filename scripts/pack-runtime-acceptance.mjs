import assert from 'node:assert/strict'
import { once } from 'node:events'
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import WebSocket from 'ws'

export const installedRuntimeAcceptance = async ({
  baseUrl,
  cookie,
  packageRoot,
  tempDir,
  workspace,
  bootstrap,
  root,
}) => {
  const call = async (path, body, method = 'POST') => {
    const response = await fetch(baseUrl + path, {
      method: body === undefined ? 'GET' : method,
      headers: { cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    assert.ok(
      response.ok,
      `${path}: ${response.status} ${response.ok ? '' : await response.text()}`
    )
    return response.status === 204 ? null : response.json()
  }
  const wait = async (fn) => {
    const end = Date.now() + 20000
    while (Date.now() < end) {
      const value = await fn()
      if (value) return value
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error('Installed runtime acceptance timed out')
  }
  const fixture = join(tempDir, 'release-cli.cjs')
  copyFileSync(join(root, 'tests/fixtures/release-cli.cjs'), fixture)
  const orch = `${workspace.id}:orchestrator`,
    worker = await call(`/api/workspaces/${workspace.id}/workers`, {
      name: 'Fixture worker',
      role: 'coder',
    })
  const runs = []
  const sockets = []
  let browser
  try {
    // Wait for the preceding packaged `team list` process to exit.
    const old = await call(`/api/ui/workspaces/${workspace.id}/runs`)
    for (const run of old.runs ?? old)
      if (run.status === 'running' || run.status === 'starting') {
        const oldId = run.run_id ?? run.runId
        await call(`/api/runtime/runs/${oldId}/stop`, {})
        await wait(async () =>
          ['exited', 'error'].includes((await call(`/api/runtime/runs/${oldId}`)).status)
        )
      }
    await wait(async () => {
      const resources = await call('/api/resources')
      return resources.occupancy.global === 0
    })
    for (const id of [orch, worker.id]) {
      await call(`/api/workspaces/${workspace.id}/agents/${encodeURIComponent(id)}/config`, {
        command: process.execPath,
        args: [fixture, join(packageRoot, 'dist/src/cli/team.js')],
      })
      const policyPath = `/api/ui/workspaces/${workspace.id}/agents/${encodeURIComponent(id)}/execution-policy`,
        policy = await call(policyPath)
      await call(
        policyPath,
        {
          profile: 'trusted_unsafe',
          expected_cli_fingerprint: policy.cli_fingerprint,
          expected_cli_version: policy.cli_version,
          policy_revision: policy.policy_revision,
          acknowledge_unsafe: true,
        },
        'PUT'
      )
      runs.push(
        await call(`/api/workspaces/${workspace.id}/agents/${encodeURIComponent(id)}/start`, {})
      )
    }
    const runId = runs[0].runId ?? runs[0].run_id
    await wait(async () => {
      const run = await call(`/api/runtime/runs/${runId}`)
      if (['error', 'exited'].includes(run.status))
        throw new Error(`Fixture exited before readiness: ${run.output}`)
      return run.output.includes('READY 中文')
    }).catch(async (error) => {
      const run = await call(`/api/runtime/runs/${runId}`)
      throw new Error(
        `${error.message}; fixture status=${run.status}; output=${run.output.slice(-4000)}`
      )
    })
    const id = crypto.randomUUID(),
      base = baseUrl.replace('http:', 'ws:') + `/ws/terminal/${runId}`
    const control = new WebSocket(`${base}/control?clientId=${id}&snapshot=1`, {
        headers: { cookie },
      }),
      io = new WebSocket(`${base}/io?clientId=${id}&snapshot=1`, { headers: { cookie } })
    sockets.push(control, io)
    io.on('message', (raw) => {
      if (control.readyState === 1)
        control.send(
          JSON.stringify({ type: 'output_ack', bytes: Buffer.byteLength(raw.toString()) })
        )
    })
    await Promise.all([once(io, 'open'), once(control, 'open')])
    io.send('HIVE_ACCEPT_SEND\r')
    const dispatch = await wait(async () =>
      (await call(`/api/ui/workspaces/${workspace.id}/delivery`)).items.find(
        (item) => item.state === 'reported'
      )
    ).catch(async (error) => {
      for (const run of runs) {
        const live = await call(`/api/runtime/runs/${run.runId ?? run.run_id}`)
        console.log('fixture diagnostics', live.status, live.output.slice(-6000))
      }
      throw error
    })
    assert.equal(dispatch.report_outcome, 'success')
    await call(`/api/ui/workspaces/${workspace.id}/dispatches/${dispatch.id}/accept`, {
      report_revision: dispatch.report_revision,
    })
    if (process.env.HIVE_PLAYWRIGHT_MODULE) {
      const { chromium } = await import(pathToFileURL(process.env.HIVE_PLAYWRIGHT_MODULE).href)
      browser = await chromium.launch({ headless: true })
      const page = await browser.newPage({ viewport: { width: 700, height: 900 }, hasTouch: true }),
        errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(`${baseUrl}/#hive_bootstrap=${await bootstrap()}`)
      const input = page.locator('.xterm-helper-textarea').first()
      await input.waitFor({ state: 'attached', timeout: 25000 })
      await input.focus()
      await page.keyboard.insertText('中文发布验收')
      await page.keyboard.press('Enter')
      await wait(async () =>
        (await call(`/api/runtime/runs/${runId}`)).output.includes('ECHO:中文发布验收')
      )
      await page.setViewportSize({ width: 640, height: 900 })
      await page.evaluate(() => {
        document.documentElement.style.zoom = '1.5'
      })
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false
      )
      assert.deepEqual(errors, [])
      console.log('[pack-smoke] installed Chromium UI, narrow/zoom and Chinese PTY input passed')
    } else console.log('[pack-smoke] browser not run: HIVE_PLAYWRIGHT_MODULE is unset')
    const tasks = await call(`/api/workspaces/${workspace.id}/tasks`)
    await call(
      `/api/workspaces/${workspace.id}/tasks`,
      { content: '- [ ] Release persistence 中文', expected_version: tasks.version },
      'PUT'
    )
    return { workspace_id: workspace.id, dispatch_id: dispatch.id }
  } finally {
    await browser?.close()
    for (const socket of sockets) socket.terminate()
    for (const run of runs) await call(`/api/runtime/runs/${run.runId ?? run.run_id}/stop`, {})
  }
}

export const verifyInstalledRestart = async (baseUrl, cookie, receipt) => {
  const response = await fetch(`${baseUrl}/api/ui/workspaces/${receipt.workspace_id}/delivery`, {
    headers: { cookie },
  })
  assert.equal(response.status, 200)
  const history = await response.json(),
    dispatch = history.items.find((item) => item.id === receipt.dispatch_id)
  assert.equal(dispatch.state, 'reported')
  assert.ok(dispatch.accepted_at)
  const tasks = await fetch(`${baseUrl}/api/workspaces/${receipt.workspace_id}/tasks`, {
    headers: { cookie },
  })
  assert.ok((await tasks.json()).content.includes('Release persistence 中文'))
  console.log(
    '[pack-smoke] installed runtime restart preserves accepted report and versioned tasks'
  )
}
