import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { grokSessionSummaryPath } from '../../src/server/native-session-adapters.js'
import Database from '../../src/server/sqlite.js'
import type { NativeSessionView } from '../../src/shared/native-session.js'
import { startAuthorizedTestServer, type startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

// Only vendor release certification is isolated. HTTP, native processes, hooks, resource limits and SQLite are real.
const certification = vi.hoisted(() => ({ enabled: true }))
vi.mock('../../src/server/native-session-profile.js', async (original) => ({
  ...(await original<typeof import('../../src/server/native-session-profile.js')>()),
  verifiedNativeSessionProfile: (harness: string, policy: { launch?: { args?: string[] } }) =>
    certification.enabled
      ? {
          harness,
          revision: 'synthetic-v1',
          platform: process.platform,
          version: 'synthetic',
          invocation_prefix: policy.launch?.args?.slice(0, 5) ?? [],
          startup_identity: 'private_plugin',
          cursor_existence: 'acp_load',
          grok_storage: 'summary_v1',
        }
      : null,
}))
const roots: string[] = []
const servers: Awaited<ReturnType<typeof startTestServer>>[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  vi.unstubAllEnvs()
  certification.enabled = true
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
const fixture = async (harness: 'cursor' | 'grok') => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hive-native-session-')))
  roots.push(root)
  vi.stubEnv('HOME', root)
  vi.stubEnv('USERPROFILE', root)
  vi.stubEnv('GROK_HOME', join(root, '.grok'))
  const cwd = join(root, 'workspace')
  mkdirSync(cwd)
  const server = await startAuthorizedTestServer({ dataDir: join(root, 'hive') })
  servers.push(server)
  const workspace = server.store.createWorkspace(cwd, 'Native session fixture')
  const worker = server.store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
  server.store.configureAgentLaunch(workspace.id, worker.id, {
    command: process.execPath,
    args: [
      resolve('tests/fixtures/native-session-cli.cjs'),
      '--fixture-harness',
      harness,
      '--fixture-root',
      root,
    ],
    interactiveCommand: harness === 'cursor' ? 'agent' : 'grok',
  })
  const cookie = await getUiCookie(server.baseUrl)
  const sessionPath = `/api/ui/workspaces/${workspace.id}/agents/${worker.id}/native-session`
  const request = (path: string, body?: unknown) =>
    fetch(server.baseUrl + path, {
      method: body ? 'POST' : 'GET',
      headers: { cookie, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  const start = () =>
    request(`/api/workspaces/${workspace.id}/agents/${worker.id}/start`, {
      hive_port: new URL(server.baseUrl).port,
    })
  const view = async () =>
    (await request(sessionPath)).json() as Promise<
      NativeSessionView & { proposed_context: unknown }
    >
  const stop = async (runId: string) => {
    server.store.stopAgentRun(runId)
    await vi.waitFor(
      () =>
        expect(
          server.store.resources.findActive(workspace.id, `agent:${worker.id}`)
        ).toBeUndefined(),
      { timeout: 10000 }
    )
  }
  const nativeFile = (view: NativeSessionView) => {
    const binding = view.current
    if (!binding?.native_id) throw new Error('Expected a durable native fixture binding')
    return harness === 'cursor'
      ? join(root, '.cursor', binding.native_id, 'fixture.json')
      : grokSessionSummaryPath(binding.context, binding.native_id)
  }
  return {
    root,
    cwd,
    server,
    workspace,
    worker,
    cookie,
    sessionPath,
    request,
    start,
    view,
    stop,
    nativeFile,
  }
}

describe('managed native session lifecycle through HTTP, PTY and SQLite', () => {
  test.each([
    'cursor',
    'grok',
  ] as const)('%s binds once, rejects unsafe automated input and resumes its history after reopening SQLite', async (harness) => {
    const f = await fixture(harness)
    const responses = await Promise.all([f.start(), f.start()])
    const runs = await Promise.all(
      responses.map(async (response) => {
        const body = await response.json()
        expect(response.status, JSON.stringify(body)).toBe(201)
        return body
      })
    )
    expect(runs[0].run_id).toBe(runs[1].run_id)
    const initial = await f.view()
    expect(initial.current).toMatchObject({ harness, generation: 1, state: 'bound' })
    expect(initial.current?.native_id).toBeTruthy()
    expect(initial.attempts).toHaveLength(1)
    expect(initial.attempts[0]?.state).toBe('active')
    expect(initial).toMatchObject({
      delivery_receipt: 'unverified',
      automatic_input: false,
      external_ownership: 'unknown',
    })
    await f.server.store.dispatchTask(f.workspace.id, f.worker.id, 'Long task '.repeat(2000))
    expect(JSON.parse(readFileSync(f.nativeFile(initial), 'utf8')).messages).toEqual([])
    await vi.waitFor(
      () =>
        expect(
          f.server.store.dispatchDelivery.view(f.workspace.id).deliveries[0],
          JSON.stringify(f.server.store.dispatchDelivery.view(f.workspace.id).deliveries[0])
        ).toMatchObject({ state: 'manual', evidence: 'none', confirmed_at: null }),
      { timeout: 5000 }
    )
    f.server.store.writeRunInput(runs[0].run_id, 'retained fixture history\r')
    await vi.waitFor(
      () =>
        expect(readFileSync(f.nativeFile(initial), 'utf8')).toContain('retained fixture history'),
      { timeout: 5000 }
    )
    await f.stop(runs[0].run_id)
    await f.server.close()
    servers.splice(servers.indexOf(f.server), 1)
    const reopened = await startAuthorizedTestServer({ dataDir: join(f.root, 'hive') })
    servers.push(reopened)
    const cookie = await getUiCookie(reopened.baseUrl)
    const response = await fetch(
      `${reopened.baseUrl}/api/workspaces/${f.workspace.id}/agents/${f.worker.id}/start`,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ hive_port: new URL(reopened.baseUrl).port }),
      }
    )
    const body = await response.json()
    expect(response.status, JSON.stringify(body)).toBe(201)
    const restored = await reopened.store.nativeSessions.view(f.workspace.id, f.worker.id)
    expect(restored.current?.native_id).toBe(initial.current?.native_id)
    expect(restored.history).toHaveLength(1)
    await vi.waitFor(
      () =>
        expect(reopened.store.getLiveRun(body.run_id).output).toContain('retained fixture history'),
      { timeout: 5000 }
    )
    const invocations = readFileSync(join(f.root, 'invocations.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(invocations.filter((item) => item.args.includes('create-chat'))).toHaveLength(
      harness === 'cursor' ? 1 : 0
    )
    const last = invocations.at(-1).args as string[]
    expect(last.slice(-2)).toEqual(['--resume', initial.current?.native_id])
  })

  test('Cursor preserves missing and denied bindings and supports explicit new generations with stale-write protection', async () => {
    const f = await fixture('cursor')
    const run = await (await f.start()).json()
    await f.stop(run.run_id)
    const initial = await f.view()
    writeFileSync(join(f.root, 'mode.json'), JSON.stringify({ denied: true }))
    const denied = await f.start()
    expect(denied.status).toBe(409)
    expect((await denied.json()).code).toBe('session_access_denied')
    writeFileSync(join(f.root, 'mode.json'), '{}')
    unlinkSync(f.nativeFile(initial))
    const missing = await f.start()
    expect(missing.status).toBe(409)
    expect((await missing.json()).code).toBe('session_missing')
    const kept = await f.view()
    expect(kept.current?.native_id).toBe(initial.current?.native_id)
    const change = {
      action: 'new',
      expected_generation_id: kept.current?.id,
      expected_context: kept.proposed_context,
      reason: 'Original native history was removed',
      acknowledge: true,
    }
    expect((await f.request(f.sessionPath, change)).status).toBe(200)
    expect((await f.request(f.sessionPath, change)).status).toBe(409)
    expect((await f.start()).status).toBe(201)
    const next = await f.view()
    expect(next.history).toHaveLength(2)
    expect(next.current?.native_id).not.toBe(initial.current?.native_id)
    expect(next.history[1]?.native_id).toBe(initial.current?.native_id)
  })

  test('allocation failure and binding persistence failure cannot cause an automatic second allocation', async () => {
    const f = await fixture('cursor')
    const db = new Database(join(f.server.dataDir, 'runtime.sqlite'))
    db.exec(
      "CREATE TRIGGER fail_native_bind BEFORE UPDATE OF native_id ON native_session_generations BEGIN SELECT RAISE(ABORT,'synthetic bind failure'); END"
    )
    const response = await f.start()
    expect(response.status).toBe(500)
    db.exec('DROP TRIGGER fail_native_bind')
    db.close()
    expect((await f.view()).current?.state).toBe('uncertain')
    const retry = await f.start()
    expect(retry.status).toBe(409)
    expect((await retry.json()).code).toBe('session_allocation_uncertain')
    expect(readFileSync(join(f.root, 'invocations.jsonl'), 'utf8').trim().split('\n')).toHaveLength(
      1
    )
  })

  test('wrong native identity stops the PTY and keeps the bound ID and error', async () => {
    const f = await fixture('grok')
    writeFileSync(join(f.root, 'mode.json'), JSON.stringify({ wrong_identity: true }))
    const response = await f.start()
    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('session_identity_mismatch')
    const view = await f.view()
    expect(view.current?.native_id).toBeTruthy()
    expect(view.current?.last_error?.code).toBe('session_identity_mismatch')
    expect(f.server.store.getAgent(f.workspace.id, f.worker.id).status).toBe('stopped')
    expect(JSON.parse(readFileSync(f.nativeFile(view), 'utf8')).messages).toEqual([])
  })

  test('unknown vendor releases never allocate even after explicit execution permission', async () => {
    const f = await fixture('cursor')
    certification.enabled = false
    const response = await f.start()
    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('session_adapter_unverified')
    const view = await f.view()
    expect(view.current).toBeNull()
    expect(view.reason_code).toBe('session_adapter_unverified')
    expect(
      f.server.store.resources.findActive(f.workspace.id, `agent:${f.worker.id}`)
    ).toBeUndefined()
  })

  test('Cursor preparation and PTY fit a one-process budget without admitting another member', async () => {
    const f = await fixture('cursor')
    f.server.store.resources.updateLimits({ max_running_total: 1 }, { actor: 'local_user' })
    const response = await f.start()
    expect(response.status).toBe(201)
    expect(f.server.store.resources.getSnapshot().occupancy.global).toBe(1)
    const second = f.server.store.addWorker(f.workspace.id, { name: 'Bob', role: 'coder' })
    const config = f.server.store.peekAgentLaunchConfig(f.workspace.id, f.worker.id)
    if (!config) throw new Error('Missing fixture config')
    f.server.store.configureAgentLaunch(f.workspace.id, second.id, config)
    const blocked = await f.request(`/api/workspaces/${f.workspace.id}/agents/${second.id}/start`, {
      hive_port: new URL(f.server.baseUrl).port,
    })
    expect(blocked.status).toBe(409)
    expect((await f.server.store.nativeSessions.view(f.workspace.id, second.id)).current).toBeNull()
    const first = await f.view()
    expect(
      (
        await f.request(f.sessionPath, {
          action: 'new',
          expected_generation_id: first.current?.id,
          expected_context: first.proposed_context,
          reason: 'Cannot replace a live writer',
          acknowledge: true,
        })
      ).status
    ).toBe(409)
  })

  test('same-directory members and another workspace retain separate IDs and native histories', async () => {
    const f = await fixture('grok')
    const otherCwd = join(f.root, 'second-workspace')
    mkdirSync(otherCwd)
    const otherWorkspace = f.server.store.createWorkspace(otherCwd, 'Other workspace')
    const bob = f.server.store.addWorker(f.workspace.id, { name: 'Bob', role: 'coder' })
    const carol = f.server.store.addWorker(otherWorkspace.id, { name: 'Carol', role: 'reviewer' })
    const config = f.server.store.peekAgentLaunchConfig(f.workspace.id, f.worker.id)
    if (!config) throw new Error('Missing fixture config')
    f.server.store.configureAgentLaunch(f.workspace.id, bob.id, config)
    f.server.store.configureAgentLaunch(otherWorkspace.id, carol.id, config)
    const targets = [
      [f.workspace.id, f.worker.id],
      [f.workspace.id, bob.id],
      [otherWorkspace.id, carol.id],
    ] as const
    const runs = await Promise.all(
      targets.map(async ([workspaceId, agentId]) => {
        const response = await f.request(`/api/workspaces/${workspaceId}/agents/${agentId}/start`, {
          hive_port: new URL(f.server.baseUrl).port,
        })
        expect(response.status).toBe(201)
        return response.json()
      })
    )
    const views = await Promise.all(
      targets.map(([workspaceId, agentId]) =>
        f.server.store.nativeSessions.view(workspaceId, agentId)
      )
    )
    expect(new Set(views.map((view) => view.current?.native_id)).size).toBe(3)
    for (const [index, run] of runs.entries())
      f.server.store.writeRunInput(run.run_id, `only-member-${index}\r`)
    for (const [index, view] of views.entries())
      await vi.waitFor(() => {
        const binding = view.current
        if (!binding?.native_id) throw new Error('Missing fixture binding')
        const messages = JSON.parse(
          readFileSync(grokSessionSummaryPath(binding.context, binding.native_id), 'utf8')
        ).messages.join('')
        expect(messages).toContain(`only-member-${index}`)
        expect(messages).not.toContain(`only-member-${(index + 1) % 3}`)
      })
  })

  test.each([
    'draft',
    'permission_dialog',
  ])('%s never receives automatic terminal input or a false receipt', async (mode) => {
    const f = await fixture('grok')
    writeFileSync(join(f.root, 'mode.json'), JSON.stringify({ [mode]: true }))
    expect((await f.start()).status).toBe(201)
    const view = await f.view()
    await f.server.store.dispatchTask(
      f.workspace.id,
      f.worker.id,
      'Do not overwrite the human composer'
    )
    expect(JSON.parse(readFileSync(f.nativeFile(view), 'utf8')).messages).toEqual([])
    await vi.waitFor(
      () =>
        expect(
          f.server.store.dispatchDelivery.view(f.workspace.id).deliveries[0],
          JSON.stringify(f.server.store.dispatchDelivery.view(f.workspace.id).deliveries[0])
        ).toMatchObject({ state: 'manual', evidence: 'none', confirmed_at: null }),
      { timeout: 5000 }
    )
  })

  test('policy changes require an explicit environment rebind and retain the same native ID', async () => {
    const f = await fixture('grok')
    const run = await (await f.start()).json()
    await f.stop(run.run_id)
    const before = await f.view()
    const db = new Database(join(f.server.dataDir, 'runtime.sqlite'))
    db.prepare("UPDATE workers SET role='reviewer' WHERE id=?").run(f.worker.id)
    db.close()
    await f.server.close()
    servers.splice(servers.indexOf(f.server), 1)
    const reopened = await startAuthorizedTestServer({ dataDir: join(f.root, 'hive') })
    servers.push(reopened)
    const cookie = await getUiCookie(reopened.baseUrl)
    const request = (path: string, body: unknown) =>
      fetch(reopened.baseUrl + path, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const startPath = `/api/workspaces/${f.workspace.id}/agents/${f.worker.id}/start`
    const mismatch = await request(startPath, { hive_port: new URL(reopened.baseUrl).port })
    expect(mismatch.status).toBe(409)
    expect((await mismatch.json()).code).toBe('session_environment_mismatch')
    const changed = await reopened.store.nativeSessions.view(f.workspace.id, f.worker.id)
    expect(changed.current?.native_id).toBe(before.current?.native_id)
    const rebound = await request(f.sessionPath, {
      action: 'rebind',
      expected_generation_id: before.current?.id,
      expected_context: changed.proposed_context,
      reason: 'Reviewed new reviewer role',
      acknowledge: true,
    })
    expect(rebound.status).toBe(200)
    expect((await request(startPath, { hive_port: new URL(reopened.baseUrl).port })).status).toBe(
      201
    )
    expect(
      (await reopened.store.nativeSessions.view(f.workspace.id, f.worker.id)).current?.native_id
    ).toBe(before.current?.native_id)
  })

  test('cwd and platform changes are reported without clearing the original binding', async () => {
    const f = await fixture('cursor')
    const run = await (await f.start()).json()
    await f.stop(run.run_id)
    const before = await f.view()
    const db = new Database(join(f.server.dataDir, 'runtime.sqlite'))
    for (const change of [{ cwd: join(f.root, 'moved') }, { platform: 'another-platform' }]) {
      db.prepare('UPDATE native_session_generations SET context_json=? WHERE id=?').run(
        JSON.stringify({ ...before.current?.context, ...change }),
        before.current?.id
      )
      const response = await f.start()
      expect(response.status).toBe(409)
      expect((await response.json()).code).toBe('session_environment_mismatch')
      expect((await f.view()).current?.native_id).toBe(before.current?.native_id)
    }
    db.close()
  })

  test('an interrupted allocation survives reopening SQLite and cannot allocate again', async () => {
    const f = await fixture('cursor')
    writeFileSync(join(f.root, 'mode.json'), JSON.stringify({ allocation_failure: true }))
    expect((await f.start()).status).toBe(409)
    const before = await f.view()
    expect(before.current?.state).toBe('uncertain')
    await f.server.close()
    servers.splice(servers.indexOf(f.server), 1)
    const reopened = await startAuthorizedTestServer({ dataDir: join(f.root, 'hive') })
    servers.push(reopened)
    await expect(
      reopened.store.startAgent(f.workspace.id, f.worker.id, {
        hivePort: new URL(reopened.baseUrl).port,
      })
    ).rejects.toMatchObject({ code: 'session_allocation_uncertain' })
    expect(
      (await reopened.store.nativeSessions.view(f.workspace.id, f.worker.id)).current?.id
    ).toBe(before.current?.id)
    expect(readFileSync(join(f.root, 'invocations.jsonl'), 'utf8').trim().split('\n')).toHaveLength(
      1
    )
  })

  test('legacy native IDs are imported without allocating or erasing history', async () => {
    const f = await fixture('cursor')
    const db = new Database(join(f.server.dataDir, 'runtime.sqlite'))
    db.prepare(
      'INSERT INTO agent_sessions(workspace_id,agent_id,last_session_id,updated_at) VALUES(?,?,?,?)'
    ).run(f.workspace.id, f.worker.id, 'legacy-cursor-id', Date.now())
    const imported = await f.view()
    expect(imported.current).toMatchObject({ native_id: 'legacy-cursor-id', state: 'bound' })
    expect(imported.reason_code).toBe('session_environment_mismatch')
    const response = await f.start()
    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('session_environment_mismatch')
    expect(
      db.prepare('SELECT last_session_id FROM agent_sessions WHERE agent_id=?').get(f.worker.id)
    ).toEqual({ last_session_id: 'legacy-cursor-id' })
    db.close()
  })

  test('extra prompt and session flags are rejected before any native allocation', async () => {
    const f = await fixture('cursor')
    const config = f.server.store.peekAgentLaunchConfig(f.workspace.id, f.worker.id)
    if (!config) throw new Error('Missing fixture launch config')
    for (const args of [['-p', 'premature prompt'], ['--resume', 'someone-else'], ['--continue']]) {
      f.server.store.configureAgentLaunch(f.workspace.id, f.worker.id, {
        ...config,
        args: [...(config.args ?? []), ...args],
      })
      const response = await f.start()
      expect(response.status).toBe(409)
      expect((await response.json()).code).toBe('session_environment_mismatch')
    }
    expect(existsSync(join(f.root, 'invocations.jsonl'))).toBe(false)
    expect((await f.view()).current).toBeNull()
  })

  test('a missing, malformed or mismatched Grok summary retains the binding and explains the failure', async () => {
    const f = await fixture('grok')
    const run = await (await f.start()).json()
    await f.stop(run.run_id)
    const bound = await f.view(),
      path = f.nativeFile(bound)
    const data = JSON.parse(readFileSync(path, 'utf8'))
    for (const damaged of ['null', '[]', '{"info":null}', '{']) {
      writeFileSync(path, damaged)
      const malformed = await f.start()
      expect(malformed.status).toBe(409)
      expect((await malformed.json()).code).toBe('session_native_failure')
      expect((await f.view()).current?.native_id).toBe(bound.current?.native_id)
    }
    data.info.cwd = join(f.root, 'another-member')
    writeFileSync(path, JSON.stringify(data))
    const mismatch = await f.start()
    expect(mismatch.status).toBe(409)
    expect((await mismatch.json()).code).toBe('session_identity_mismatch')
    unlinkSync(path)
    const missing = await f.start()
    expect(missing.status).toBe(409)
    expect((await missing.json()).code).toBe('session_missing')
    expect((await f.view()).current?.native_id).toBe(bound.current?.native_id)
  })

  test('cancelling Cursor allocation kills its real helper before releasing the slot and leaves an uncertain result', async () => {
    const f = await fixture('cursor')
    f.server.store.resources.updateLimits({ max_running_total: 1 }, { actor: 'local_user' })
    writeFileSync(join(f.root, 'mode.json'), JSON.stringify({ allocation_delay: 5000 }))
    const starting = f.start()
    await vi.waitFor(
      () => {
        expect(existsSync(join(f.root, 'invocations.jsonl'))).toBe(true)
        expect(
          f.server.store.resources.findActive(f.workspace.id, `agent:${f.worker.id}`)?.state
        ).toBe('running')
      },
      { timeout: 5000 }
    )
    f.server.store.cancelPendingAgentStart(f.workspace.id, f.worker.id)
    const response = await starting
    expect(response.status).toBe(409)
    expect((await f.view()).current?.state).toBe('uncertain')
    expect(
      f.server.store.resources.findActive(f.workspace.id, `agent:${f.worker.id}`)
    ).toBeUndefined()
    const retry = await f.start()
    expect(retry.status).toBe(409)
    expect((await retry.json()).code).toBe('session_allocation_uncertain')
    expect(readFileSync(join(f.root, 'invocations.jsonl'), 'utf8').trim().split('\n')).toHaveLength(
      1
    )
  })
})
