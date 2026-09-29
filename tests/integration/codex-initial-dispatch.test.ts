import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import Database from '../../src/server/sqlite.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers = new Set<Awaited<ReturnType<typeof startTestServer>>>()
const roots: string[] = []
afterEach(async () => {
  for (const server of servers) await server.close()
  servers.clear()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir(), 'hive-initial-dispatch-')))
      throw new Error('Unexpected fixture path')
    rmSync(root, { recursive: true, force: true, maxRetries: 10 })
  }
})

interface Launch {
  agentId: string
  args: string[]
  prompt: string | null
  sessionId: string
  resumedId: string | null
  historyPath: string
  stdinPath: string
}
const skillBody =
  '固定技能原文："quoted" & | ^ %PATH% !bang! < > 🐝\n第二行：中文边界\n第三行：保留空格  与换行\n'
const taskBody =
  '需求文档逐行确认 🐝\n"quoted" & | ^ %PATH% !bang! < >\n' +
  Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 行：完整保留该行内容、空格 和换行。`).join('\n')
const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-initial-dispatch-'))
  roots.push(root)
  vi.stubEnv('CODEX_HOME', join(root, 'native-home'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  const command = join(root, 'codex.js')
  writeFileSync(
    command,
    `import {runInitialDispatchCli} from ${JSON.stringify(new URL('../fixtures/codex-initial-dispatch-cli.mjs', import.meta.url).href)};runInitialDispatchCli(${JSON.stringify(root)});`
  )
  const dataDir = join(root, 'data')
  const workspacePath = join(root, 'workspace 中文')
  mkdirSync(workspacePath)
  const server = await startTestServer({ dataDir })
  servers.add(server)
  const workspace = server.store.createWorkspace(workspacePath, 'Native first dispatch')
  const actorId = `${workspace.id}:orchestrator`
  server.store.configureAgentLaunch(workspace.id, actorId, {
    command: process.execPath,
    args: ['-e', 'console.log("MAIN_READY");process.stdin.resume();setInterval(()=>{},1000)'],
  })
  const worker = server.store.addWorker(workspace.id, {
    name: '需求访谈员',
    role: 'custom',
    description: 'Read the complete assigned task and Skill.',
  })
  server.store.configureAgentLaunch(workspace.id, worker.id, {
    command,
    commandPresetId: 'codex',
    args: [],
    resumeArgsTemplate: 'resume {session_id}',
    sessionIdCapture: {
      source: 'codex_session_jsonl_dir',
      pattern: '~/.codex/sessions/**/*.jsonl',
    },
  })
  const cookie = await getUiCookie(server.baseUrl)
  const policyPath = (id: string) =>
    `${server.baseUrl}/api/ui/workspaces/${workspace.id}/agents/${id}/execution-policy`
  for (const id of [actorId, worker.id]) {
    const preview = await (await fetch(policyPath(id), { headers: { cookie } })).json()
    const granted = await fetch(policyPath(id), {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        profile: 'trusted_unsafe',
        expected_cli_fingerprint: preview.cli_fingerprint,
        expected_cli_version: preview.cli_version,
        policy_revision: preview.policy_revision,
        acknowledge_unsafe: true,
      }),
    })
    expect(granted.status).toBe(200)
  }
  const started = await fetch(
    `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${actorId}/start`,
    { method: 'POST', headers: { cookie } }
  )
  expect(started.status).toBe(201)
  const pack = join(root, 'pack')
  mkdirSync(join(pack, 'analysis'), { recursive: true })
  writeFileSync(
    join(pack, 'analysis/SKILL.md'),
    `---\nname: analysis\ndescription: Fixture task analysis\n---\n${skillBody}`
  )
  const release = await server.store.skills.resolvePack({
    packName: 'fixture',
    source: { type: 'local', path: pack },
  })
  const plan = await server.store.skills.plan(workspace.id, {
    action: 'bind',
    packName: 'fixture',
    releaseId: release.id,
    nativeExposure: [],
    profiles: { orchestrator: ['analysis'], custom: ['analysis'] },
  })
  await server.store.skills.applyPlan(workspace.id, plan.id)
  const launches = (): Launch[] =>
    existsSync(join(root, 'launches.jsonl'))
      ? readFileSync(join(root, 'launches.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : []
  const send = () =>
    fetch(`${server.baseUrl}/api/team/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspace.id,
        from_agent_id: actorId,
        token: server.store.peekAgentToken(actorId),
        to: worker.name,
        text: taskBody,
        skill_name: 'fixture/analysis',
        timeouts: { delivery_ms: 5000 },
      }),
    })
  const restart = async () => {
    await server.close()
    servers.delete(server)
    const next = await startTestServer({ dataDir })
    servers.add(next)
    const cookie = await getUiCookie(next.baseUrl)
    const response = await fetch(
      `${next.baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`,
      { method: 'POST', headers: { cookie } }
    )
    expect(response.status, await response.clone().text()).toBe(201)
    const { run_id: runId } = await response.json()
    await expect
      .poll(() => next.store.getLiveRun(runId).output, { timeout: 10000 })
      .toContain('INITIAL_DISPATCH_READY')
    return next
  }
  return { root, server, workspace, worker, cookie, policyPath, launches, send, restart }
}

test.skipIf(process.platform !== 'win32')(
  'the first worker dispatch enters native argv intact, confirms one full receipt and resumes without another write',
  async () => {
    const f = await setup()
    const response = await f.send()
    expect(response.status, await response.clone().text()).toBe(202)
    const dispatch = await response.json()
    await expect.poll(() => f.launches().length, { timeout: 10000 }).toBe(1)
    const initial = f.launches()[0]
    if (!initial) throw new Error('Expected the first native worker launch')
    expect(initial.prompt).toContain(taskBody)
    expect(initial.prompt).toContain(skillBody.trimEnd())
    expect(initial.args.at(-1)).toBe(initial.prompt)
    expect(initial.prompt).toContain(`[Hive report receipt: ${dispatch.dispatch_id}]`)
    await expect
      .poll(() => f.server.store.dispatchDelivery.records.get(dispatch.dispatch_id)?.state, {
        timeout: 10000,
      })
      .toBe('confirmed')
    expect(f.server.store.getDispatch(f.workspace.id, dispatch.dispatch_id)?.status).toBe(
      'submitted'
    )
    const receipt = f.server.store.dispatchDelivery.records.get(dispatch.dispatch_id)
    expect(receipt).toMatchObject({
      evidence: 'native_receipt',
      attempt: 1,
      session_id: initial.sessionId,
    })
    expect(JSON.parse(receipt?.checkpoint ?? '{}')).toMatchObject({
      wireFormat: 'native-initial-v1',
      wireSha256: createHash('sha256')
        .update(initial.prompt ?? '')
        .digest('hex'),
    })
    const messages = () =>
      readFileSync(initial.historyPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((record) => record.type === 'response_item' && record.payload.role === 'user')
        .map((record) => record.payload.content[0].text)
    expect(messages()).toEqual([initial.prompt])
    expect(readFileSync(initial.stdinPath, 'utf8')).toBe('')
    const next = await f.restart()
    expect(f.launches()).toHaveLength(2)
    const resumed = f.launches()[1]
    expect(resumed).toMatchObject({ resumedId: initial.sessionId, prompt: null })
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(next.store.dispatchDelivery.records.get(dispatch.dispatch_id)).toMatchObject({
      state: 'confirmed',
      attempt: 1,
    })
    expect(messages()).toEqual([initial.prompt])
    if (!resumed) throw new Error('Expected the resumed native worker')
    expect(readFileSync(resumed.stdinPath, 'utf8')).toBe('')
  },
  40000
)

test.skipIf(process.platform !== 'win32').each(['exit-before-receipt', 'drop-newlines'])(
  'an uncertain native dispatch (%s) is retained and never resent after runtime restart',
  async (mode) => {
    const f = await setup()
    writeFileSync(join(f.root, `${f.worker.id}.mode`), mode)
    const response = await f.send()
    expect(response.status, await response.clone().text()).toBe(202)
    const dispatch = await response.json()
    await expect.poll(() => f.launches().length, { timeout: 10000 }).toBe(1)
    const initial = f.launches()[0]
    if (!initial) throw new Error('Expected one attempted native launch')
    expect(initial.prompt).toContain(taskBody)
    await expect
      .poll(() => f.server.store.dispatchDelivery.records.get(dispatch.dispatch_id)?.state, {
        timeout: 10000,
      })
      .toBe('unknown')
    expect(f.server.store.getDispatch(f.workspace.id, dispatch.dispatch_id)?.status).not.toBe(
      'submitted'
    )
    if (mode === 'drop-newlines') {
      const journal = readFileSync(initial.historyPath, 'utf8')
      expect(journal).toContain(`[Hive report receipt: ${dispatch.dispatch_id}]`)
      expect(journal).not.toContain(JSON.stringify(taskBody).slice(1, -1))
    }
    const next = await f.restart()
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(next.store.dispatchDelivery.records.get(dispatch.dispatch_id)).toMatchObject({
      state: 'unknown',
      attempt: 1,
    })
    expect(next.store.getDispatch(f.workspace.id, dispatch.dispatch_id)?.status).not.toBe(
      'submitted'
    )
    expect(f.launches().filter((launch) => launch.prompt !== null)).toHaveLength(1)
    for (const launch of f.launches()) expect(readFileSync(launch.stdinPath, 'utf8')).toBe('')
  },
  40000
)

test.skipIf(process.platform !== 'win32')(
  'revoking execution authorization blocks first-dispatch argv before any worker process or write checkpoint',
  async () => {
    const f = await setup()
    const revoked = await fetch(f.policyPath(f.worker.id), {
      method: 'DELETE',
      headers: { cookie: f.cookie },
    })
    expect(revoked.status).toBe(200)
    const response = await f.send()
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'execution_policy_denied' })
    expect(f.server.store.listAgentRuns(f.worker.id)).toEqual([])
    expect(f.launches()).toEqual([])
    const dispatches = f.server.store.listDispatches(f.workspace.id)
    expect(dispatches).toHaveLength(1)
    const [dispatch] = dispatches
    if (!dispatch) throw new Error('Expected the failed task to remain durable')
    expect(dispatch.status).toBe('failed')
    const delivery = f.server.store.dispatchDelivery.records.get(dispatch.id)
    expect(delivery?.checkpoint ?? null).toBeNull()
    expect(delivery?.write_started ?? 0).toBe(0)
    expect(
      (await f.server.store.executionPolicies.preview(f.workspace.id, f.worker.id)).unsafe_grant
    ).toBeNull()
  },
  25000
)

test.skipIf(process.platform !== 'win32').each(['run-registration', 'receipt-checkpoint'])(
  'a postspawn SQLite failure (%s) closes the native process and retains the uncertain dispatch',
  async (failure) => {
    const f = await setup()
    const db = new Database(join(f.server.dataDir, 'runtime.sqlite'))
    try {
      db.exec(
        failure === 'run-registration'
          ? `CREATE TRIGGER reject_native_registration BEFORE INSERT ON agent_runs
             WHEN NEW.agent_id='${f.worker.id}'
             BEGIN SELECT RAISE(ABORT,'fixture native registration failed'); END`
          : `CREATE TRIGGER reject_native_registration BEFORE INSERT ON message_delivery_events
             WHEN NEW.event='initial_prompt_launched'
             BEGIN SELECT RAISE(ABORT,'fixture native registration failed'); END`
      )
      const response = await f.send()
      expect(response.status, await response.clone().text()).toBe(500)
      expect(await response.json()).toMatchObject({ error: 'fixture native registration failed' })
      const [dispatch] = f.server.store.listDispatches(f.workspace.id)
      if (!dispatch) throw new Error('Expected the interrupted dispatch to remain durable')
      expect(dispatch.status).toBe('failed')
      expect(f.server.store.dispatchDelivery.records.get(dispatch.id)).toMatchObject({
        state: 'unknown',
        attempt: 1,
        write_started: 1,
      })
      expect(f.server.store.peekAgentToken(f.worker.id)).toBeUndefined()
      expect(f.server.store.getAgent(f.workspace.id, f.worker.id).status).toBe('stopped')
      await expect
        .poll(() => f.server.store.resources.getSnapshot().occupancy.global, { timeout: 10000 })
        .toBe(1)
      expect(f.server.store.listAgentRuns(f.worker.id).every((run) => run.status === 'error')).toBe(
        true
      )
      db.exec('DROP TRIGGER reject_native_registration')
      const next = await f.restart()
      await new Promise((resolve) => setTimeout(resolve, 1200))
      expect(next.store.dispatchDelivery.records.get(dispatch.id)).toMatchObject({
        state: 'unknown',
        attempt: 1,
      })
      expect(f.launches().at(-1)?.prompt).toBeNull()
      for (const launch of f.launches()) expect(readFileSync(launch.stdinPath, 'utf8')).toBe('')
    } finally {
      db.close()
    }
  },
  40000
)
