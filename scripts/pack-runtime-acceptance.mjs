import assert from 'node:assert/strict'
import { once } from 'node:events'
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import WebSocket from 'ws'

const terminalText = (text) => stripVTControlCharacters(text).replace(/[\r\n]/g, '')
const processExited = (pid) => {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if (error.code === 'ESRCH') return true
    throw error
  }
}

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
  const wait = async (fn, description = 'runtime state') => {
    const end = Date.now() + 20000
    while (Date.now() < end) {
      const value = await fn()
      if (value) return value
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`Installed runtime acceptance timed out: ${description}`)
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
  const checks = {
    browser: { status: 'not_run', reason: 'HIVE_PLAYWRIGHT_MODULE is unset' },
  }
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
    const runIds = runs.map((run) => run.runId ?? run.run_id)
    const childPids = []
    for (const fixtureRunId of runIds) {
      const live = await wait(async () => {
        const run = await call(`/api/runtime/runs/${fixtureRunId}`)
        if (['error', 'exited'].includes(run.status))
          throw new Error(`Fixture exited before readiness: ${run.output}`)
        return terminalText(run.output).includes('READY 中文') && run
      }, `fixture ${fixtureRunId} readiness`).catch(async (error) => {
        const run = await call(`/api/runtime/runs/${fixtureRunId}`)
        throw new Error(
          `${error.message}; fixture status=${run.status}; output=${run.output.slice(-4000)}`
        )
      })
      const childPid = Number(terminalText(live.output).match(/CHILD_PID:(\d+)/u)?.[1])
      assert.ok(childPid, 'Fixture must report its real child process')
      childPids.push(childPid)
    }
    const runId = runIds[0]
    const id = crypto.randomUUID(),
      base = `${baseUrl.replace('http:', 'ws:')}/ws/terminal/${runId}`
    const control = new WebSocket(`${base}/control?clientId=${id}&snapshot=1`, {
        headers: { cookie },
      }),
      io = new WebSocket(`${base}/io?clientId=${id}&snapshot=1`, { headers: { cookie } })
    sockets.push(control, io)
    let output = ''
    io.on('message', (raw) => {
      output += raw.toString()
      if (control.readyState === 1)
        control.send(
          JSON.stringify({ type: 'output_ack', bytes: Buffer.byteLength(raw.toString()) })
        )
    })
    await Promise.all([once(io, 'open'), once(control, 'open')])
    const unicodeInput = `中文发布验收 ${crypto.randomUUID()}`
    io.send(`${unicodeInput}\r`)
    const unicodeEcho = `ECHO:${unicodeInput}`
    await wait(() => terminalText(output).includes(unicodeEcho), 'WebSocket PTY Unicode echo')
    checks.ws_unicode_input = {
      status: 'passed',
      run_id: runId,
      input: unicodeInput,
      echo: unicodeEcho,
    }

    const observedSizes = []
    for (const size of [
      { cols: 101, rows: 31 },
      { cols: 113, rows: 37 },
    ]) {
      control.send(JSON.stringify({ type: 'resize', ...size }))
      const observed = await wait(async () => {
        // The IO and control sockets are independent. Query the native PTY until
        // its dimensions reflect the control message, using a fresh response ID.
        const queryId = crypto.randomUUID()
        io.send(`HIVE_ACCEPT_SIZE:${queryId}\r`)
        const match = await wait(
          () => terminalText(output).match(new RegExp(`PTY_SIZE:${queryId}:(\\d+):(\\d+)`)),
          'fixture native PTY size response'
        )
        const actual = { cols: Number(match[1]), rows: Number(match[2]) }
        return actual.cols === size.cols && actual.rows === size.rows && actual
      }, `native PTY resize to ${size.cols}x${size.rows}`)
      observedSizes.push(observed)
    }
    checks.pty_resize = {
      status: 'passed',
      run_id: runId,
      source: 'fixture_fresh_tty_write_stream',
      observed_sizes: observedSizes,
    }
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
    const accepted = (await call(`/api/ui/workspaces/${workspace.id}/delivery`)).items.find(
      (item) => item.id === dispatch.id
    )
    assert.ok(accepted.accepted_at)
    checks.team_send_report_accept = {
      status: 'passed',
      dispatch_id: dispatch.id,
      report_outcome: dispatch.report_outcome,
      report_revision: dispatch.report_revision,
      accepted_at: accepted.accepted_at,
    }
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
      checks.browser = {
        status: 'passed',
        unicode_input: true,
        horizontal_overflow: false,
        page_errors: errors,
      }
      console.log('[pack-smoke] installed Chromium UI, narrow/zoom and Chinese PTY input passed')
    } else console.log('[pack-smoke] browser not run: HIVE_PLAYWRIGHT_MODULE is unset')
    const tasks = await call(`/api/workspaces/${workspace.id}/tasks`)
    const savedTasks = await call(
      `/api/workspaces/${workspace.id}/tasks`,
      { content: '- [ ] Release persistence 中文', expected_version: tasks.version },
      'PUT'
    )
    const resourcesBefore = await call('/api/resources')
    assert.equal(resourcesBefore.occupancy.global, runs.length)
    for (const socket of sockets) socket.terminate()
    for (const id of runIds) await call(`/api/runtime/runs/${id}/stop`, {})
    for (const id of runIds)
      await wait(
        async () => (await call(`/api/runtime/runs/${id}`)).status === 'exited',
        `run ${id} exited`
      )
    const agents = await wait(async () => {
      const team = await call(`/api/ui/workspaces/${workspace.id}/team`)
      // The public team list contains workers; orchestrator exit is checked above.
      const stopped = [team.find((agent) => agent.id === worker.id)]
      return stopped.every((agent) => agent?.status === 'stopped') && stopped
    }, 'agent summaries stopped')
    const resourcesAfter = await wait(async () => {
      const resources = await call('/api/resources')
      return resources.occupancy.global === 0 && resources
    }, 'all PTY reservations released')
    await wait(() => childPids.every(processExited), 'fixture child processes exited')
    checks.stop_lifecycle = {
      status: 'passed',
      run_ids: runIds,
      run_status: 'exited',
      agents: agents.map(({ id, status }) => ({ agent_id: id, status })),
      occupancy_before: resourcesBefore.occupancy.global,
      occupancy_after: resourcesAfter.occupancy.global,
      child_pids: childPids,
      child_processes_exited: true,
    }
    return {
      workspace_id: workspace.id,
      workspace_path: workspace.path,
      dispatch_id: dispatch.id,
      report_revision: dispatch.report_revision,
      tasks_version: savedTasks.version,
      tasks_content: savedTasks.content,
      checks,
    }
  } finally {
    await browser?.close()
    for (const socket of sockets) socket.terminate()
    for (const run of runs) await call(`/api/runtime/runs/${run.runId ?? run.run_id}/stop`, {})
  }
}

export const verifyInstalledRestart = async (baseUrl, cookie, receipt) => {
  const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, { headers: { cookie } })
  assert.equal(workspaceResponse.status, 200)
  const workspace = (await workspaceResponse.json()).find(
    (item) => item.id === receipt.workspace_id
  )
  assert.ok(workspace, 'Restart must preserve the workspace in SQLite')
  assert.equal(workspace.path, receipt.workspace_path)
  const response = await fetch(`${baseUrl}/api/ui/workspaces/${receipt.workspace_id}/delivery`, {
    headers: { cookie },
  })
  assert.equal(response.status, 200)
  const history = await response.json(),
    dispatch = history.items.find((item) => item.id === receipt.dispatch_id)
  assert.equal(dispatch.state, 'reported')
  assert.equal(dispatch.report_outcome, 'success')
  assert.equal(dispatch.report_revision, receipt.report_revision)
  assert.ok(dispatch.accepted_at)
  const tasks = await fetch(`${baseUrl}/api/workspaces/${receipt.workspace_id}/tasks`, {
    headers: { cookie },
  })
  assert.equal(tasks.status, 200)
  const taskSnapshot = await tasks.json()
  assert.equal(taskSnapshot.content, receipt.tasks_content)
  assert.equal(taskSnapshot.version, receipt.tasks_version)
  console.log(
    '[pack-smoke] installed runtime restart preserves accepted report and versioned tasks'
  )
  return {
    checks: {
      sqlite_restart: {
        status: 'passed',
        workspace_path: workspace.path,
        dispatch_id: dispatch.id,
        report_revision: dispatch.report_revision,
        accepted_at: dispatch.accepted_at,
        tasks_version: taskSnapshot.version,
        tasks_storage: 'workspace_file',
      },
    },
  }
}
