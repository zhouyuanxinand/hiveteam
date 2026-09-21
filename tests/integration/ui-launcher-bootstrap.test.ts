import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import { createUiLaunchUrl } from '../../scripts/ui-launcher.mjs'

test('inherited launcher IPC authenticates HTTP without exposing bootstrap in logs', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-trusted-launcher-'))
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/hive.ts', '--port', '0'], {
    cwd: process.cwd(),
    env: { ...process.env, HIVE_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  })
  let output = ''
  child.stdout?.on('data', (chunk) => {
    output += chunk.toString()
  })
  child.stderr?.on('data', (chunk) => {
    output += chunk.toString()
  })
  try {
    const deadline = Date.now() + 15_000
    while (!/Hive running at http:\/\/127\.0\.0\.1:\d+/.test(output)) {
      if (child.exitCode !== null || Date.now() > deadline) {
        throw new Error(`Runtime did not start: ${output}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const port = output.match(/Hive running at http:\/\/127\.0\.0\.1:(\d+)/)?.[1]
    const origin = `http://127.0.0.1:${port}`
    const anonymous = await fetch(`${origin}/api/ui/session`)
    expect(anonymous.status).toBe(403)
    expect(anonymous.headers.has('set-cookie')).toBe(false)
    const launchUrl = new URL(await createUiLaunchUrl(child, origin))
    expect(launchUrl.search).toBe('')
    const token = new URLSearchParams(launchUrl.hash.slice(1)).get('hive_bootstrap')
    expect(token).toBeTruthy()
    const exchange = () =>
      fetch(`${origin}/api/ui/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bootstrap_token: token }),
      })
    const session = await exchange()
    expect(session.status).toBe(200)
    const cookie = session.headers.get('set-cookie')?.split(';')[0]
    expect(cookie).toBeTruthy()
    expect(session.headers.get('set-cookie')).toContain('HttpOnly')
    expect(session.headers.get('set-cookie')).toContain('SameSite=Strict')
    expect((await exchange()).status).toBe(403)
    const refresh = await fetch(`${origin}/api/ui/session`, { headers: { cookie: cookie ?? '' } })
    expect(refresh.status).toBe(200)
    expect(refresh.headers.has('set-cookie')).toBe(false)
    const workspaces = await fetch(`${origin}/api/workspaces`, {
      headers: { cookie: cookie ?? '' },
    })
    expect(workspaces.status).toBe(200)
    expect(await workspaces.json()).toEqual([])
    const second = new URL(await createUiLaunchUrl(child, origin))
    expect(second.hash).not.toBe(launchUrl.hash)
    expect(output).not.toContain(token)
    expect(output).not.toContain(cookie)
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await exited
    }
    rmSync(dataDir, { recursive: true, force: true })
  }
}, 25_000)
