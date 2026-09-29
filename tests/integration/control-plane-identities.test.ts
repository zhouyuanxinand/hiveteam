import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'
import { createBudgetedTestAgentManager as createAgentManager } from '../helpers/budgeted-agent-manager.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

describe('control plane identities over HTTP and child processes', () => {
  test('anonymous and agent credentials cannot acquire UI or Supervisor capabilities', async () => {
    const server = await startTestServer()
    try {
      for (const path of ['/api/ui/session', '/api/external-goals/session', '/api/workspaces']) {
        const response = await fetch(server.baseUrl + path, {
          headers: { 'x-hive-agent-id': 'synthetic-worker', 'x-hive-agent-token': 'agent-token' },
        })
        expect(response.status).toBe(403)
        expect(response.headers.get('set-cookie')).toBeNull()
        expect(await response.text()).not.toContain(server.store.getUiToken())
      }
      const exchange = await fetch(`${server.baseUrl}/api/ui/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bootstrap_token: 'synthetic-agent-token' }),
      })
      expect(exchange.status).toBe(403)
      expect(exchange.headers.get('set-cookie')).toBeNull()
      expect(server.store.listWorkspaces()).toEqual([])
    } finally {
      await server.close()
    }
  })

  test('tunnel secrets are not desktop cookies and forged transport identity never falls back', async () => {
    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const forged = await fetch(`${server.baseUrl}/api/workspaces`, {
        headers: { cookie: `hive_ui_token=${server.store.getRemoteTunnelSecret()}` },
      })
      expect(forged.status).toBe(403)
      const missingDevice = await fetch(`${server.baseUrl}/api/workspaces`, {
        headers: { cookie, 'x-hive-remote-secret': server.store.getRemoteTunnelSecret() },
      })
      expect(missingDevice.status).toBe(403)
      const spoofedDevice = await fetch(`${server.baseUrl}/api/workspaces`, {
        headers: { cookie, 'x-hive-remote-device': 'not-paired' },
      })
      expect(spoofedDevice.status).toBe(403)
      const local = await fetch(`${server.baseUrl}/api/workspaces`, { headers: { cookie } })
      expect(local.status).toBe(200)
      expect(await local.json()).toEqual([])
    } finally {
      await server.close()
    }
  })

  test('only an authenticated desktop may hand off the separate Supervisor capability', async () => {
    const server = await startTestServer()
    try {
      const response = await fetch(`${server.baseUrl}/api/external-goals/session`, {
        headers: { cookie: await getUiCookie(server.baseUrl) },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      const capability = (await response.json()) as { token: string; runtime_base_url: string }
      expect(capability.runtime_base_url).toBe(server.baseUrl)
      expect(server.store.validateSupervisorToken(capability.token)).toBe(true)
      expect(server.store.validateUiToken(capability.token)).toBe(false)
      expect(server.store.validateUiToken(server.store.getRemoteTunnelSecret())).toBe(false)
    } finally {
      await server.close()
    }
  })

  test('the actual PTY child receives its team token but no management credentials', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hive-identity-child-'))
    const script = join(directory, 'environment.cjs')
    writeFileSync(
      script,
      `console.log('CHILD_IDENTITY:' + JSON.stringify({ supervisor: process.env.HIVE_SUPERVISOR_TOKEN, ui: process.env.HIVE_UI_TOKEN, bridge: process.env.HIVE_DESKTOP_BRIDGE_TOKEN, agent: process.env.HIVE_AGENT_TOKEN })); setTimeout(() => process.exit(0), 150);`
    )
    const manager = createAgentManager()
    let runId: string | undefined
    try {
      const run = await manager.startAgent({
        agentId: 'synthetic-worker',
        command: process.execPath,
        args: [script],
        cwd: directory,
        env: {
          HIVE_SUPERVISOR_TOKEN: 'synthetic-supervisor-secret',
          HIVE_UI_TOKEN: 'synthetic-ui-secret',
          HIVE_DESKTOP_BRIDGE_TOKEN: 'synthetic-desktop-secret',
          HIVE_AGENT_TOKEN: 'synthetic-team-token',
        },
      })
      runId = run.runId
      await expect
        .poll(() => manager.getRun(run.runId).output, { timeout: 10_000 })
        .toContain('CHILD_IDENTITY:')
      const output = manager.getRun(run.runId).output
      expect(output).toContain('"agent":"synthetic-team-token"')
      expect(output).not.toContain('synthetic-supervisor-secret')
      expect(output).not.toContain('synthetic-ui-secret')
      expect(output).not.toContain('synthetic-desktop-secret')
    } finally {
      if (runId) {
        manager.stopRun(runId)
        await manager.waitForRunExit?.(runId)
        manager.removeRun(runId)
      }
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
