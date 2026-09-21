import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { fetchTeamMailbox } from '../../src/cli/team-mailbox-client.js'
import { createTeamMailboxBroker } from '../../src/server/team-mailbox-broker.js'
import type { ExecutionPolicyView } from '../../src/shared/execution-policy.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []
const brokers: Array<Awaited<ReturnType<typeof createTeamMailboxBroker>>> = []
afterEach(async () => {
  for (const broker of brokers.splice(0)) await broker.close()
  for (const server of servers.splice(0)) await server.close()
  vi.unstubAllEnvs()
})

const setup = async () => {
  const server = await startTestServer()
  servers.push(server)
  const isolatedHome = join(server.dataDir, 'isolated-fixture-home')
  mkdirSync(isolatedHome)
  vi.stubEnv('HOME', isolatedHome)
  vi.stubEnv('USERPROFILE', isolatedHome)
  vi.stubEnv('XDG_CONFIG_HOME', isolatedHome)
  vi.stubEnv('GIT_CEILING_DIRECTORIES', server.dataDir)
  const root = join(server.dataDir, 'workspace')
  mkdirSync(root)
  const workspace = server.store.createWorkspace(root, 'Policy fixture')
  const worker = server.store.addWorker(workspace.id, { name: 'Synthetic coder', role: 'coder' })
  const config = {
    command: process.execPath,
    args: [
      '-e',
      'console.log("FIXTURE_ENV:"+JSON.stringify({secret:process.env.HIVE_SYNTHETIC_CLOUD_KEY??null,agent:Boolean(process.env.HIVE_AGENT_TOKEN)}));process.stdin.resume()',
    ],
  }
  server.store.configureAgentLaunch(workspace.id, worker.id, config)
  const cookie = await getUiCookie(server.baseUrl)
  const policyPath = `/api/ui/workspaces/${workspace.id}/agents/${worker.id}/execution-policy`
  const get = async () => {
    const response = await fetch(server.baseUrl + policyPath, { headers: { cookie } })
    expect(response.status).toBe(200)
    return (await response.json()) as ExecutionPolicyView
  }
  const authorize = async () => {
    const view = await get()
    const response = await fetch(server.baseUrl + policyPath, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        profile: 'trusted_unsafe',
        expected_cli_fingerprint: view.cli_fingerprint,
        expected_cli_version: view.cli_version,
        policy_revision: view.policy_revision,
        acknowledge_unsafe: true,
      }),
    })
    expect(response.status).toBe(200)
    return (await response.json()) as ExecutionPolicyView
  }
  const start = () =>
    server.store.startAgent(workspace.id, worker.id, { hivePort: new URL(server.baseUrl).port })
  return { ...server, root, workspace, worker, cookie, policyPath, config, get, authorize, start }
}

describe('execution policy across local HTTP, SQLite and real PTYs', () => {
  test('unknown capabilities deny launch and policy inspection never executes a custom CLI', async () => {
    const fixture = await setup()
    const view = await fixture.get()
    expect(view.profile).toBe('restricted')
    expect(view.enforcement).toBe('unsupported')
    expect(view.actual).toBeNull()
    await vi.waitFor(() => expect(fixture.store.resources.getSnapshot().occupancy.global).toBe(0), {
      timeout: 8000,
    })
    await expect(fixture.start()).rejects.toMatchObject({ code: 'execution_policy_denied' })
    expect(fixture.store.listAgentRuns(fixture.worker.id)).toEqual([])
    expect(fixture.store.getAgent(fixture.workspace.id, fixture.worker.id).status).toBe('stopped')
    expect(fixture.store.peekAgentToken(fixture.worker.id)).toBeUndefined()
    const marker = join(fixture.root, 'executed')
    const command = join(fixture.root, process.platform === 'win32' ? 'custom.cmd' : 'custom.sh')
    writeFileSync(
      command,
      process.platform === 'win32' ? `@echo unsafe>"${marker}"` : `#!/bin/sh\ntouch '${marker}'\n`,
      { mode: 0o700 }
    )
    fixture.store.configureAgentLaunch(fixture.workspace.id, fixture.worker.id, { command })
    expect((await fixture.get()).cli_version).toBeNull()
    expect(existsSync(marker)).toBe(false)
  })

  test('local grants are scoped, immutable active snapshots survive revoke and children exclude unrelated secrets', async () => {
    vi.stubEnv('HIVE_SYNTHETIC_CLOUD_KEY', 'synthetic-private-parent-key')
    const fixture = await setup()
    const granted = await fixture.authorize()
    expect(granted.enforcement).toBe('trusted_unsafe')
    const run = await fixture.start()
    await vi.waitFor(
      () =>
        expect(fixture.store.getLiveRun(run.runId).output).toContain(
          'FIXTURE_ENV:{"secret":null,"agent":true}'
        ),
      { timeout: 8000 }
    )
    const active = (await fixture.get()).active_policy
    expect(active?.profile).toBe('trusted_unsafe')
    const unauthorized = await fetch(fixture.baseUrl + fixture.policyPath, {
      method: 'DELETE',
      headers: {
        'x-hive-agent-id': fixture.worker.id,
        'x-hive-agent-token': fixture.store.peekAgentToken(fixture.worker.id) ?? '',
      },
    })
    expect(unauthorized.status).toBe(403)
    const revoked = await fetch(fixture.baseUrl + fixture.policyPath, {
      method: 'DELETE',
      headers: { cookie: fixture.cookie },
    })
    expect(revoked.status).toBe(200)
    const after = await fixture.get()
    expect(after.profile).toBe('restricted')
    expect(after.active_policy).toEqual(active)
    const database = new Database(join(fixture.dataDir, 'runtime.sqlite'), { readonly: true })
    try {
      const row = database
        .prepare('SELECT snapshot_json FROM execution_policy_snapshots WHERE run_id = ?')
        .get(run.runId) as { snapshot_json: string }
      const snapshot = JSON.parse(row.snapshot_json)
      expect(snapshot.policy_id).toBe(active?.policy_id)
      expect(snapshot.launch.command).toBe(realpathSync(process.execPath))
      expect(snapshot.launch.args).toEqual(fixture.config.args)
      expect(row.snapshot_json).not.toContain('synthetic-private-parent-key')
      expect(
        database.prepare('SELECT action, actor FROM execution_policy_events ORDER BY rowid').all()
      ).toEqual([
        { action: 'grant_unsafe', actor: 'local_user' },
        { action: 'revoke_unsafe', actor: 'local_user' },
      ])
    } finally {
      database.close()
    }
    fixture.store.stopAgentRun(run.runId)
    await vi.waitFor(() =>
      expect(
        fixture.store.getActiveRunByAgentId(fixture.workspace.id, fixture.worker.id)
      ).toBeUndefined()
    )
    await vi.waitFor(() => expect(fixture.store.resources.getSnapshot().occupancy.global).toBe(0), {
      timeout: 8000,
    })
    await expect(fixture.start()).rejects.toMatchObject({ code: 'execution_policy_denied' })
  })

  test('a changed launch configuration invalidates old grant and stale local confirmation', async () => {
    const fixture = await setup()
    const old = await fixture.authorize()
    fixture.store.configureAgentLaunch(fixture.workspace.id, fixture.worker.id, {
      ...fixture.config,
      args: ['-e', 'process.stdin.resume()'],
    })
    const next = await fixture.get()
    expect(next.profile).toBe('restricted')
    expect(next.cli_fingerprint).not.toBe(old.cli_fingerprint)
    await expect(fixture.start()).rejects.toMatchObject({ code: 'execution_policy_denied' })
    const response = await fetch(fixture.baseUrl + fixture.policyPath, {
      method: 'PUT',
      headers: { cookie: fixture.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        profile: 'trusted_unsafe',
        expected_cli_fingerprint: old.cli_fingerprint,
        expected_cli_version: old.cli_version,
        policy_revision: old.policy_revision,
        acknowledge_unsafe: true,
      }),
    })
    expect(response.status).toBe(409)
    expect(fixture.store.listAgentRuns(fixture.worker.id)).toEqual([])
  })

  test('revocation during launch preparation prevents the real PTY from starting', async () => {
    const fixture = await setup()
    await fixture.authorize()
    let release: () => void = () => {}
    let notifyPrepared: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const reachedPreparation = new Promise<void>((resolve) => {
      notifyPrepared = resolve
    })
    const original = fixture.store.executionPolicies.prepare.bind(fixture.store.executionPolicies)
    const spy = vi
      .spyOn(fixture.store.executionPolicies, 'prepare')
      .mockImplementation(async (input) => {
        const prepared = await original(input)
        notifyPrepared()
        await held
        return prepared
      })
    const starting = fixture.start()
    await reachedPreparation
    await fixture.store.executionPolicies.revoke(fixture.workspace.id, fixture.worker.id)
    release()
    await expect(starting).rejects.toMatchObject({
      code: 'execution_policy_denied',
      missingCapabilities: ['launch_policy_changed'],
    })
    spy.mockRestore()
    expect(fixture.store.listAgentRuns(fixture.worker.id)).toEqual([])
    expect(fixture.store.peekAgentToken(fixture.worker.id)).toBeUndefined()
    expect(fixture.store.getAgent(fixture.workspace.id, fixture.worker.id).status).toBe('stopped')
  })

  test('snapshot persistence failure prevents process creation and revokes the pending team token', async () => {
    const fixture = await setup()
    await fixture.authorize()
    const database = new Database(join(fixture.dataDir, 'runtime.sqlite'))
    try {
      database.exec(
        "CREATE TRIGGER reject_policy BEFORE INSERT ON execution_policy_snapshots BEGIN SELECT RAISE(ABORT, 'synthetic persistence failure'); END"
      )
      await expect(fixture.start()).rejects.toThrow('synthetic persistence failure')
      expect(fixture.store.listAgentRuns(fixture.worker.id)).toEqual([])
      expect(fixture.store.peekAgentToken(fixture.worker.id)).toBeUndefined()
      expect(database.prepare('SELECT id FROM execution_policy_snapshots').all()).toEqual([])
    } finally {
      database.close()
    }
  })

  test('real team CLI reports through a bound mailbox while management, cross-workspace and revoked requests fail', async () => {
    const fixture = await setup()
    await fixture.authorize()
    await fixture.start()
    const token = fixture.store.peekAgentToken(fixture.worker.id)
    if (!token) throw new Error('Expected active synthetic member token')
    let active = true
    const broker = await createTeamMailboxBroker({
      root: join(fixture.dataDir, 'mailbox-fixture'),
      workspaceId: fixture.workspace.id,
      agentId: fixture.worker.id,
      token,
      hivePort: new URL(fixture.baseUrl).port,
      isActive: () => active && fixture.store.validateAgentToken(fixture.worker.id, token),
    })
    brokers.push(broker)
    const output = await promisify(execFile)(
      process.execPath,
      [resolve('dist/bin/team'), 'status', 'synthetic mailbox status'],
      {
        cwd: fixture.root,
        env: {
          ...process.env,
          HIVE_TEAM_MAILBOX: broker.path,
          HIVE_PROJECT_ID: fixture.workspace.id,
          HIVE_AGENT_ID: fixture.worker.id,
          HIVE_AGENT_TOKEN: 'mailbox',
          HIVE_PORT: new URL(fixture.baseUrl).port,
        },
        timeout: 10_000,
      }
    )
    expect(output.stdout + output.stderr).not.toContain(token)
    const messages = fixture.store.listMessagesForRecovery(fixture.workspace.id, 0)
    expect(JSON.stringify(messages)).toContain('synthetic mailbox status')
    expect(JSON.stringify(messages)).not.toContain(token)
    const responseName = readdirSync(join(broker.path, 'responses')).find((name) =>
      name.endsWith('.json')
    )
    if (!responseName) throw new Error('Expected the real CLI delivery acknowledgement')
    const delivered = JSON.parse(
      readFileSync(join(broker.path, 'responses', responseName), 'utf8')
    ) as { id: string }
    const replayPath = join(broker.path, 'requests', `${delivered.id}.json`)
    writeFileSync(
      replayPath,
      JSON.stringify({
        id: delivered.id,
        created_at: Date.now(),
        method: 'POST',
        path: '/api/team/status',
        body: JSON.stringify({
          project_id: fixture.workspace.id,
          from_agent_id: fixture.worker.id,
          result: 'replayed mutation',
        }),
      })
    )
    await vi.waitFor(() => expect(existsSync(replayPath)).toBe(false))
    expect(fixture.store.listMessagesForRecovery(fixture.workspace.id, 0)).toEqual(messages)
    const expiredId = randomUUID()
    const expiredResponse = join(broker.path, 'responses', `${expiredId}.json`)
    writeFileSync(
      join(broker.path, 'requests', `${expiredId}.json`),
      JSON.stringify({
        id: expiredId,
        created_at: Date.now() - 60_000,
        method: 'POST',
        path: '/api/team/status',
        body: '{}',
      })
    )
    await vi.waitFor(() => expect(existsSync(expiredResponse)).toBe(true))
    expect(JSON.parse(readFileSync(expiredResponse, 'utf8')).status).toBe(403)
    const request = (path: string, projectId = fixture.workspace.id) =>
      fetchTeamMailbox(broker.path, path, {
        method: 'POST',
        body: JSON.stringify({
          project_id: projectId,
          from_agent_id: fixture.worker.id,
          result: 'should not dispatch',
          to: 'Synthetic coder',
          text: 'forbidden child dispatch',
          token: 'forged',
        }),
      })
    expect((await request('/api/ui/session')).status).toBe(403)
    expect((await request('/api/team/status', 'different-workspace')).status).toBe(403)
    const roleDenied = await request('/api/team/send')
    expect(roleDenied.status).toBe(403)
    active = false
    const revoked = await request('/api/team/status')
    expect(revoked.status).toBe(403)
    expect(await revoked.text()).not.toContain(token)
    expect(fixture.store.listMessagesForRecovery(fixture.workspace.id, 0)).toEqual(messages)
  })

  test('the authenticated commit route advances only the coder branch and rejects stale HEAD and reviewer roles', async () => {
    const fixture = await setup()
    const home = join(fixture.dataDir, 'synthetic-git-home')
    mkdirSync(home)
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    vi.stubEnv('XDG_CONFIG_HOME', home)
    writeFileSync(
      join(home, '.gitconfig'),
      '[user]\nname = Fixture User\nemail = fixture@example.invalid\n'
    )
    const git = async (cwd: string, args: string[]) =>
      (
        await promisify(execFile)('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
          cwd,
          env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
        })
      ).stdout.trim()
    await git(fixture.root, ['init', '-b', 'main'])
    writeFileSync(join(fixture.root, 'source.txt'), 'initial\n')
    await git(fixture.root, ['add', '.'])
    await git(fixture.root, ['commit', '-m', 'Initial fixture'])
    const baseHead = await git(fixture.root, ['rev-parse', 'HEAD'])
    const tree = await fixture.store.worktrees.create(fixture.workspace, fixture.worker.id)
    await fixture.authorize()
    await fixture.start()
    writeFileSync(join(tree.checkoutPath, 'source.txt'), 'updated by synthetic coder\n')
    const commit = (agentId: string, expectedHead: string) =>
      fetch(`${fixture.baseUrl}/api/team/git/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: fixture.workspace.id,
          from_agent_id: agentId,
          token: fixture.store.peekAgentToken(agentId),
          expected_head: expectedHead,
          message: 'Synthetic worker change',
        }),
      })
    const response = await commit(fixture.worker.id, baseHead)
    expect(response.status).toBe(200)
    const result = (await response.json()) as {
      committed: boolean
      commit_sha: string
      parent_sha: string
      branch: string
    }
    expect(result).toMatchObject({ committed: true, parent_sha: baseHead, branch: tree.branch })
    expect(await git(tree.checkoutPath, ['rev-parse', 'HEAD'])).toBe(result.commit_sha)
    expect(await git(fixture.root, ['rev-parse', 'HEAD'])).toBe(baseHead)
    expect((await commit(fixture.worker.id, baseHead)).status).toBe(409)
    const reviewer = fixture.store.addWorker(fixture.workspace.id, {
      name: 'Synthetic reviewer',
      role: 'reviewer',
    })
    fixture.store.configureAgentLaunch(fixture.workspace.id, reviewer.id, fixture.config)
    const view = await fixture.store.executionPolicies.preview(fixture.workspace.id, reviewer.id)
    await fixture.store.executionPolicies.update(fixture.workspace.id, reviewer.id, {
      profile: 'trusted_unsafe',
      expected_cli_fingerprint: view.cli_fingerprint,
      expected_cli_version: view.cli_version,
      policy_revision: view.policy_revision,
      acknowledge_unsafe: true,
    })
    await fixture.store.startAgent(fixture.workspace.id, reviewer.id, {
      hivePort: new URL(fixture.baseUrl).port,
    })
    expect((await commit(reviewer.id, baseHead)).status).toBe(403)
    expect(await git(tree.checkoutPath, ['rev-parse', 'HEAD'])).toBe(result.commit_sha)
  }, 20_000)
})
