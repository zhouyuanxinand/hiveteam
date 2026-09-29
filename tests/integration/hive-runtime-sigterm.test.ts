import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'
import { requestUiBootstrap } from '../../scripts/ui-launcher.mjs'
import { seedDefaultSkillPackCache } from '../helpers/default-skill-pack-fixture.js'

const tempDirs: string[] = []
const children: Array<{ child: ChildProcess; closed: Promise<number | null> }> = []
const describeUnixOnly = process.platform === 'win32' ? describe.skip : describe

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 5000,
  intervalMs = 50
) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() <= deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  throw lastError
}

afterEach(async () => {
  for (const { child, closed } of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await closed
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describeUnixOnly('hive runtime SIGTERM shutdown', () => {
  test('SIGTERM exits runtime and cleans up active PTY child', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-sigterm-test-'))
    const workspacePath = join(root, 'workspace')
    tempDirs.push(root)
    mkdirSync(workspacePath, { recursive: true })
    const marker = `hive-sigterm-marker-${crypto.randomUUID()}`

    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx/esm',
        '--input-type=module',
        '-e',
        "import { runHiveCommand } from './src/cli/hive.ts'; import { installUiLauncher } from './src/cli/ui-launcher.ts'; const runtime = await runHiveCommand(['--port','0']); installUiLauncher(runtime.store, runtime.port); process.send({ type: 'hive:runtime-ready', port: runtime.port });",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, HIVE_DATA_DIR: join(root, 'data') },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      }
    )
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    children.push({ child, closed })
    let port: number | null = null
    child.on('message', (message) => {
      if (
        message !== null &&
        typeof message === 'object' &&
        'type' in message &&
        message.type === 'hive:runtime-ready' &&
        'port' in message &&
        typeof message.port === 'number'
      )
        port = message.port
    })
    await waitFor(() => expect(port).toEqual(expect.any(Number)))

    const baseUrl = `http://127.0.0.1:${port}`
    await waitFor(async () => {
      const response = await fetch(`${baseUrl}/api/version`)
      expect(response.status).toBe(200)
    })

    const cookieResponse = await fetch(`${baseUrl}/api/ui/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bootstrap_token: await requestUiBootstrap(child) }),
    })
    const cookie = cookieResponse.headers.get('set-cookie')
    expect(cookieResponse.status).toBe(200)
    if (!cookie) {
      throw new Error('Expected UI session cookie')
    }

    await seedDefaultSkillPackCache(join(root, 'data'), root)
    const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'Alpha', path: workspacePath }),
    })
    expect(workspaceResponse.status).toBe(201)
    const workspace = (await workspaceResponse.json()) as { id: string }
    const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'Alice', role: 'coder' }),
    })
    expect(workerResponse.status).toBe(201)
    const worker = (await workerResponse.json()) as { id: string }

    const configResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/config`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)', '--', marker],
        }),
      }
    )
    expect(configResponse.status).toBe(204)

    const policyPath = `${baseUrl}/api/ui/workspaces/${workspace.id}/agents/${worker.id}/execution-policy`
    const policyResponse = await fetch(policyPath, { headers: { cookie } })
    expect(policyResponse.status).toBe(200)
    const policy = await policyResponse.json()
    const approved = await fetch(policyPath, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        profile: 'trusted_unsafe',
        expected_cli_fingerprint: policy.cli_fingerprint,
        expected_cli_version: policy.cli_version,
        policy_revision: policy.policy_revision,
        acknowledge_unsafe: true,
      }),
    })
    expect(approved.status).toBe(200)

    const startResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ hive_port: String(port) }),
      }
    )
    expect(startResponse.status, await startResponse.text()).toBe(201)

    const matchingProcesses = () =>
      execFileSync('ps', ['-ww', '-eo', 'pid=,args='], { encoding: 'utf8' })
        .split('\n')
        .filter((line) => line.includes(marker))
    await waitFor(() => expect(matchingProcesses()).toHaveLength(1))

    child.kill('SIGTERM')

    expect(await closed).toBe(0)

    expect(matchingProcesses()).toEqual([])
  }, 15000)
})
