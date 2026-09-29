import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import { createUiLaunchUrl } from '../../scripts/ui-launcher.mjs'

const startRuntime = (dataDir: string) => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/hive.ts', '--port', '0'], {
    cwd: process.cwd(),
    env: { ...process.env, HIVE_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  })
  if (!child.stdout || !child.stderr) throw new Error('Runtime output pipes were not created')
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    output += chunk.toString()
  })
  return {
    child,
    async ready() {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline && child.exitCode === null) {
        const origin = output.match(/Hive running at (http:\/\/127\.0\.0\.1:\d+)/)?.[1]
        if (origin) return origin
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error(`Runtime did not start: ${output}`)
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return
      const closed = once(child, 'close')
      child.send({ type: 'hive:shutdown' })
      const [code, signal] = await closed
      expect({ code, signal }).toEqual({ code: 0, signal: null })
    },
  }
}

test('a restarted runtime requires a new launcher exchange while its health stays available', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-launcher-restart-'))
  const first = startRuntime(dataDir)
  let second: ReturnType<typeof startRuntime> | undefined
  const exchange = async (runtime: ReturnType<typeof startRuntime>, origin: string) => {
    const launchUrl = new URL(await createUiLaunchUrl(runtime.child, origin))
    const response = await fetch(`${origin}/api/ui/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        bootstrap_token: new URLSearchParams(launchUrl.hash.slice(1)).get('hive_bootstrap'),
      }),
    })
    expect(response.status).toBe(200)
    const cookie = response.headers.get('set-cookie')?.split(';')[0]
    if (!cookie) throw new Error('Launcher exchange did not issue a session cookie')
    return cookie
  }
  try {
    const firstOrigin = await first.ready()
    const staleCookie = await exchange(first, firstOrigin)
    expect(
      (await fetch(`${firstOrigin}/api/workspaces`, { headers: { cookie: staleCookie } })).status
    ).toBe(200)
    await first.stop()

    second = startRuntime(dataDir)
    const origin = await second.ready()
    expect((await fetch(`${origin}/api/version`)).status).toBe(200)
    const staleSession = await fetch(`${origin}/api/ui/session`, {
      headers: { cookie: staleCookie },
    })
    expect(staleSession.status).toBe(403)
    expect(staleSession.headers.has('set-cookie')).toBe(false)
    expect(
      (await fetch(`${origin}/api/workspaces`, { headers: { cookie: staleCookie } })).status
    ).toBe(403)

    const freshCookie = await exchange(second, origin)
    expect(freshCookie === staleCookie).toBe(false)
    expect(
      (await fetch(`${origin}/api/ui/session`, { headers: { cookie: freshCookie } })).status
    ).toBe(200)
    const workspaces = await fetch(`${origin}/api/workspaces`, {
      headers: { cookie: freshCookie },
    })
    expect(workspaces.status).toBe(200)
    expect(await workspaces.json()).toEqual([])
  } finally {
    await first.stop()
    await second?.stop()
    rmSync(dataDir, { recursive: true, force: true })
  }
}, 40_000)
