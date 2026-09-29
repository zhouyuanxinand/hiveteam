import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { stampLoopbackHeaders } from '../../src/server/remote-loopback-auth.js'
import Database from '../../src/server/sqlite.js'
import { cursorDiagnostic, grokDiagnostic } from '../fixtures/session-cli-diagnostics.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Awaited<ReturnType<typeof startTestServer>>[] = []
const roots: string[] = []
const databases: Database.Database[] = []
afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  for (const server of servers.splice(0)) await server.close()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const fixture = async () => {
  const server = await startTestServer()
  servers.push(server)
  return { ...server, cookie: await getUiCookie(server.baseUrl) }
}
const endpoint = '/api/settings/session-adapters'

describe('session adapter diagnostics over authenticated HTTP', () => {
  test('lists evidence without executing discovered CLIs or changing presets and sessions', async () => {
    const server = await fixture()
    const root = mkdtempSync(join(tmpdir(), 'hive-session-diagnostic-'))
    roots.push(root)
    const marker = join(root, 'executed.txt')
    const script = join(root, 'cli.cjs')
    writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`)
    for (const name of ['agent', 'cursor-agent', 'grok']) {
      const file = join(root, process.platform === 'win32' ? `${name}.cmd` : name)
      writeFileSync(
        file,
        process.platform === 'win32'
          ? `@"${process.execPath}" "${script}"\r\n`
          : `#!${process.execPath}\n${`require(${JSON.stringify(script)})`}\n`
      )
      if (process.platform !== 'win32') chmodSync(file, 0o700)
    }
    vi.stubEnv('PATH', root)
    const presets = server.store.settings.listCommandPresets()
    const response = await fetch(server.baseUrl + endpoint, { headers: { cookie: server.cookie } })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const reports = await response.json()
    expect(reports.map((report: { harness: string }) => report.harness)).toEqual(['cursor', 'grok'])
    expect(reports[0]).toMatchObject({
      runtime_platform: process.platform,
      diagnostic: null,
      verified_releases: [],
      command_locations: [
        { command: 'agent', status: 'resolved' },
        { command: 'cursor-agent', status: 'resolved' },
      ],
      automatic_resume: { allowed: false },
    })
    expect(reports[1].diagnostic_commands.version).toEqual(['version'])
    expect(existsSync(marker)).toBe(false)
    expect(server.store.settings.listCommandPresets()).toEqual(presets)
    expect(server.store.listWorkspaces()).toEqual([])
  })

  test('analyzes imported evidence without certifying the runtime or persisting a new session', async () => {
    const server = await fixture()
    const database = new Database(join(server.dataDir, 'runtime.sqlite'))
    databases.push(database)
    database
      .prepare(
        'INSERT INTO agent_sessions (workspace_id, agent_id, last_session_id, updated_at) VALUES (?, ?, ?, ?)'
      )
      .run('fixture-workspace', 'fixture-worker', 'fixture-existing-session', 1)
    const bindings = database.prepare('SELECT * FROM agent_sessions').all()
    for (const [harness, diagnostic] of [
      ['cursor', cursorDiagnostic],
      ['grok', grokDiagnostic],
    ] as const) {
      const response = await fetch(`${server.baseUrl}${endpoint}/${harness}/diagnose`, {
        method: 'POST',
        headers: { cookie: server.cookie, 'content-type': 'application/json' },
        body: JSON.stringify(diagnostic),
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toMatchObject({
        harness,
        verified_releases: [],
        automatic_resume: { allowed: false },
        diagnostic: {
          source: 'imported',
          command: diagnostic.command,
          platform: diagnostic.platform,
          version_status: 'reported',
        },
        capabilities: {
          allocate: {
            documentation: 'documented',
            help_observation: 'advertised',
            runtime_support: 'unverified',
          },
          resume_by_id: {
            documentation: 'documented',
            help_observation: 'advertised',
            runtime_support: 'unverified',
          },
          delivery_receipt: { documentation: 'unverified', runtime_support: 'unverified' },
        },
      })
    }
    const fresh = await fetch(server.baseUrl + endpoint, { headers: { cookie: server.cookie } })
    expect(
      (await fresh.json()).every((report: { diagnostic: unknown }) => report.diagnostic === null)
    ).toBe(true)
    expect(server.store.listWorkspaces()).toEqual([])
    expect(database.prepare('SELECT * FROM agent_sessions').all()).toEqual(bindings)
  })

  test('rejects anonymous, agent and paired remote identities before exposing local diagnostics', async () => {
    const server = await fixture()
    const device = server.store.remote.devices.insert({
      id: randomUUID(),
      name: 'Diagnostic test phone',
      keys: { d2p: new Uint8Array(32).fill(1), p2d: new Uint8Array(32).fill(2) },
      devicePublicKey: new Uint8Array(32).fill(3),
    })
    for (const headers of [
      {},
      { 'x-hive-agent-id': 'worker', 'x-hive-agent-token': 'synthetic-team-token' },
      stampLoopbackHeaders({}, server.store.getRemoteTunnelSecret(), device.id),
    ]) {
      for (const [method, suffix] of [
        ['GET', ''],
        ['POST', '/cursor/diagnose'],
      ] as const) {
        const response = await fetch(`${server.baseUrl}${endpoint}${suffix}`, {
          method,
          headers: { ...headers, 'content-type': 'application/json' },
          ...(method === 'POST' ? { body: JSON.stringify(cursorDiagnostic) } : {}),
        })
        expect(response.status).toBe(403)
        expect(await response.json()).not.toHaveProperty('command_locations')
      }
    }
  })

  test('returns bounded typed input errors and rejects unknown harnesses', async () => {
    const server = await fixture()
    const call = (body: string, harness = 'grok') =>
      fetch(`${server.baseUrl}${endpoint}/${harness}/diagnose`, {
        method: 'POST',
        headers: { cookie: server.cookie, 'content-type': 'application/json' },
        body,
      })
    for (const body of [
      '{',
      'null',
      JSON.stringify({ ...grokDiagnostic, command: 'grok; echo unsafe' }),
      JSON.stringify({ ...grokDiagnostic, version: { exit_code: 0, stdout: [], stderr: '' } }),
    ]) {
      const response = await call(body)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'invalid_session_diagnostic' })
    }
    expect((await call(JSON.stringify(grokDiagnostic), 'claude')).status).toBe(404)
    expect(
      (
        await call(
          JSON.stringify({
            ...grokDiagnostic,
            help: { exit_code: 0, stdout: 'x'.repeat(65536), stderr: '' },
          })
        )
      ).status
    ).toBe(413)
  })
})
