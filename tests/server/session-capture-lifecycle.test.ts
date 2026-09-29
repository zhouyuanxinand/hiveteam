import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import {
  buildAgentRunBootstrap,
  startAgentRunCapture,
} from '../../src/server/agent-run-bootstrap.js'
import { createAgentSessionStore } from '../../src/server/agent-session-store.js'
import { buildAgentLegacyIdentityMarker } from '../../src/server/agent-startup-instructions.js'
import { resetSessionCaptureCoordinatorForTests } from '../../src/server/claude-session-coordinator.js'
import { encodeClaudeProjectPath } from '../../src/server/session-capture-claude.js'
import Database from '../../src/server/sqlite.js'
import { createAuthorizedTestRuntimeStore as createRuntimeStore } from '../helpers/authorized-runtime.js'

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  resetSessionCaptureCoordinatorForTests()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const fixture = () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-session-lifecycle-'))
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }))
  const store = createRuntimeStore({ dataDir })
  cleanups.push(() => store.close())
  const workspace = store.createWorkspace(join(dataDir, '项目 space'), 'Recovery')
  const alice = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
  const bob = store.addWorker(workspace.id, { name: 'Bob', role: 'tester' })
  const db = new Database(join(dataDir, 'runtime.sqlite'))
  cleanups.push(() => {
    db.close()
  })
  const sessions = createAgentSessionStore(db)
  const codexHome = join(dataDir, 'native-home')
  vi.stubEnv('CODEX_HOME', codexHome)
  const config = {
    command: 'codex',
    resumeArgsTemplate: 'resume {session_id}',
    sessionIdCapture: {
      source: 'codex_session_jsonl_dir' as const,
      pattern: '~/.codex/sessions/**/*.jsonl',
    },
  }
  const bootstrap = (agent = alice) => {
    const boot = buildAgentRunBootstrap(
      workspace,
      agent.id,
      config,
      sessions,
      () => undefined,
      agent
    )
    boot.commitSessionContext()
    return boot
  }
  const writeSession = (agent = alice, sessionId = randomUUID()) => {
    const sessionDir = join(codexHome, 'sessions', '2026', '09', '17')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(
      join(sessionDir, `rollout-${sessionId}.jsonl`),
      `${JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: workspace.path } })}\n${JSON.stringify({ text: `Hive session binding: workspace_id=${workspace.id}; agent_id=${agent.id}` })}\n`
    )
    return sessionId
  }
  const readSession = (agent = alice) =>
    db.prepare('SELECT last_session_id FROM agent_sessions WHERE agent_id = ?').get(agent.id)
  return {
    alice,
    bob,
    bootstrap,
    codexHome,
    config,
    db,
    readSession,
    sessions,
    workspace,
    writeSession,
  }
}

test('persists a native session created after the first thirty seconds', async () => {
  const f = fixture()
  vi.useFakeTimers()
  startAgentRunCapture({
    ...f.bootstrap(),
    agentId: f.alice.id,
    sessionStore: f.sessions,
    workspace: f.workspace,
  })
  await vi.advanceTimersByTimeAsync(31_000)
  expect(f.readSession()).toBeUndefined()
  const id = f.writeSession()
  await vi.advanceTimersByTimeAsync(1500)
  expect(f.readSession()).toEqual({ last_session_id: id })
})

test('concurrent Codex members in the same directory retain their own conversations', async () => {
  const f = fixture()
  vi.useFakeTimers()
  for (const agent of [f.alice, f.bob]) {
    startAgentRunCapture({
      ...f.bootstrap(agent),
      agentId: agent.id,
      sessionStore: f.sessions,
      workspace: f.workspace,
    })
  }
  const aliceSessionId = f.writeSession(f.alice)
  const bobSessionId = f.writeSession(f.bob)
  await vi.advanceTimersByTimeAsync(1500)
  expect(f.readSession(f.alice)).toEqual({ last_session_id: aliceSessionId })
  expect(f.readSession(f.bob)).toEqual({ last_session_id: bobSessionId })
})

test('recovers a matching native session that was not captured before restart', () => {
  const f = fixture()
  f.bootstrap()
  const id = f.writeSession()
  const restartedSessions = createAgentSessionStore(f.db)
  const resumed = buildAgentRunBootstrap(
    f.workspace,
    f.alice.id,
    f.config,
    restartedSessions,
    () => undefined,
    f.alice
  )
  expect(resumed.startConfig.resumedSessionId).toBe(id)
  expect(resumed.startConfig.args).toEqual(['resume', id])
  expect(f.readSession()).toEqual({ last_session_id: id })
})

test('keeps the original native home when the launching environment changes', () => {
  const f = fixture()
  f.bootstrap()
  const id = f.writeSession()
  f.sessions.setLastSessionId(f.workspace.id, f.alice.id, id)
  vi.stubEnv('CODEX_HOME', join(f.codexHome, 'different-home'))
  const resumed = f.bootstrap()
  expect(resumed.startConfig.resumedSessionId).toBe(id)
  expect(resumed.startEnv).toHaveProperty('CODEX_HOME', f.codexHome)
  expect(f.readSession()).toEqual({ last_session_id: id })
})

test('retains the binding and blocks a fresh conversation when the native session disappears', () => {
  const f = fixture()
  f.bootstrap()
  const id = f.writeSession()
  f.sessions.setLastSessionId(f.workspace.id, f.alice.id, id)
  unlinkSync(join(f.codexHome, 'sessions', '2026', '09', '17', `rollout-${id}.jsonl`))
  expect(() => f.bootstrap()).toThrow(/saved.*session/i)
  expect(f.readSession()).toEqual({ last_session_id: id })
  f.writeSession(f.alice, id)
  expect(f.bootstrap().startConfig.resumedSessionId).toBe(id)
})

test('captures the native flush at exit and does not keep writing after capture stops', async () => {
  const f = fixture()
  vi.useFakeTimers()
  const stop = startAgentRunCapture({
    ...f.bootstrap(),
    agentId: f.alice.id,
    sessionStore: f.sessions,
    workspace: f.workspace,
  })
  const id = f.writeSession()
  stop()
  expect(f.readSession()).toEqual({ last_session_id: id })
  f.writeSession()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.readSession()).toEqual({ last_session_id: id })
})

test('does not attach a desktop conversation or another member during recovery', () => {
  const f = fixture()
  f.bootstrap()
  f.writeSession(f.bob)
  expect(f.bootstrap().startConfig.resumedSessionId).toBeUndefined()
  expect(f.readSession()).toBeUndefined()
})

test('blocks ambiguous native histories without changing the saved binding', () => {
  const f = fixture()
  f.bootstrap()
  f.writeSession()
  f.writeSession()
  expect(() => f.bootstrap()).toThrow(/Multiple native conversations/)
  expect(f.readSession()).toBeUndefined()
})

test('a failed first resume does not pin an incorrect launch home permanently', () => {
  const f = fixture()
  const id = f.writeSession()
  f.sessions.setLastSessionId(f.workspace.id, f.alice.id, id)
  vi.stubEnv('CODEX_HOME', join(f.codexHome, 'wrong-home'))
  expect(() => f.bootstrap()).toThrow(/Saved native session/)
  expect(f.sessions.getCaptureContext(f.workspace.id, f.alice.id)).toBeUndefined()
  vi.stubEnv('CODEX_HOME', f.codexHome)
  expect(f.bootstrap().startConfig.resumedSessionId).toBe(id)
})

test('legacy display names alone cannot reattach a conversation from another workspace', () => {
  const f = fixture()
  const claudeRoot = join(f.codexHome, 'claude-projects')
  vi.stubEnv('HIVE_CLAUDE_PROJECTS_DIR', claudeRoot)
  const dir = join(claudeRoot, encodeClaudeProjectPath(f.workspace.path))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${randomUUID()}.jsonl`),
    JSON.stringify({
      text: buildAgentLegacyIdentityMarker({ agent: f.alice, workspace: f.workspace }),
    })
  )
  const boot = buildAgentRunBootstrap(
    f.workspace,
    f.alice.id,
    {
      command: 'claude',
      resumeArgsTemplate: '--resume {session_id}',
      sessionIdCapture: {
        source: 'claude_project_jsonl_dir',
        pattern: '~/.claude/projects/{encoded_cwd}/*.jsonl',
      },
    },
    f.sessions,
    () => undefined,
    f.alice
  )
  expect(boot.startConfig.resumedSessionId).toBeUndefined()
  expect(f.readSession()).toBeUndefined()
})

test('live capture ignores a new same-name Claude conversation with a different member ID', async () => {
  const f = fixture()
  vi.useFakeTimers()
  const claudeRoot = join(f.codexHome, 'claude-projects')
  vi.stubEnv('HIVE_CLAUDE_PROJECTS_DIR', claudeRoot)
  const dir = join(claudeRoot, encodeClaudeProjectPath(f.workspace.path))
  mkdirSync(dir, { recursive: true })
  const config = {
    command: 'claude',
    resumeArgsTemplate: '--resume {session_id}',
    sessionIdCapture: {
      source: 'claude_project_jsonl_dir' as const,
      pattern: '~/.claude/projects/{encoded_cwd}/*.jsonl',
    },
  }
  const boot = buildAgentRunBootstrap(
    f.workspace,
    f.alice.id,
    config,
    f.sessions,
    () => undefined,
    f.alice
  )
  boot.commitSessionContext()
  startAgentRunCapture({
    ...boot,
    agentId: f.alice.id,
    sessionStore: f.sessions,
    workspace: f.workspace,
  })
  writeFileSync(
    join(dir, `${randomUUID()}.jsonl`),
    JSON.stringify({
      text: `${buildAgentLegacyIdentityMarker({ agent: f.alice, workspace: f.workspace })}\nHive session binding: workspace_id=${f.workspace.id}; agent_id=deleted-agent`,
    })
  )
  await vi.advanceTimersByTimeAsync(1500)
  expect(f.readSession()).toBeUndefined()

  const ownId = randomUUID()
  const ownFile = join(dir, `${ownId}.jsonl`)
  writeFileSync(ownFile, '{}\n')
  await vi.advanceTimersByTimeAsync(1500)
  expect(f.readSession()).toBeUndefined()
  appendFileSync(
    ownFile,
    JSON.stringify({
      text: `Hive session binding: workspace_id=${f.workspace.id}; agent_id=${f.alice.id}`,
    })
  )
  await vi.advanceTimersByTimeAsync(1500)
  expect(f.readSession()).toEqual({ last_session_id: ownId })
  expect(
    buildAgentRunBootstrap(f.workspace, f.alice.id, config, f.sessions, () => undefined, f.alice)
      .startConfig.resumedSessionId
  ).toBe(ownId)
})

test('explicit offline recovery resumes an unmarked legacy session without rewriting its native file', () => {
  const f = fixture()
  f.bootstrap()
  const id = f.writeSession()
  const file = join(f.codexHome, 'sessions', '2026', '09', '17', `rollout-${id}.jsonl`)
  const content = `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: f.workspace.path } })}\n`
  writeFileSync(file, content)
  f.sessions.setLastSessionId(f.workspace.id, f.alice.id, id)
  expect(() => f.bootstrap()).toThrow(/does not belong to this member/)
  const context = f.sessions.getCaptureContext(f.workspace.id, f.alice.id)
  if (!context) throw new Error('Expected saved capture context')
  f.sessions.saveCaptureContext(f.workspace.id, f.alice.id, { ...context, recoveredSessionId: id })
  const boot = f.bootstrap()
  expect(boot.startConfig.resumedSessionId).toBe(id)
  expect(boot.startConfig.args).toEqual(['resume', id])
  expect(f.sessions.getCaptureContext(f.workspace.id, f.alice.id)?.recoveredSessionId).toBe(id)
  expect(readFileSync(file, 'utf8')).toBe(content)
  unlinkSync(file)
  expect(() => f.bootstrap()).toThrow(/Saved native session/)
  expect(f.readSession()).toEqual({ last_session_id: id })
})

test('an explicit recovery record cannot authorize a different saved native ID', () => {
  const f = fixture()
  f.bootstrap()
  const foreignId = f.writeSession(f.bob)
  const context = f.sessions.getCaptureContext(f.workspace.id, f.alice.id)
  if (!context) throw new Error('Expected saved capture context')
  f.sessions.saveCaptureContext(f.workspace.id, f.alice.id, {
    ...context,
    recoveredSessionId: randomUUID(),
  })
  f.sessions.setLastSessionId(f.workspace.id, f.alice.id, foreignId)
  expect(() => f.bootstrap()).toThrow(/does not belong to this member/)
  expect(f.readSession()).toEqual({ last_session_id: foreignId })
})
