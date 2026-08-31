import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { buildAgentRunBootstrap } from '../../src/server/agent-run-bootstrap.js'
import type { AgentSessionStore } from '../../src/server/agent-session-store.js'
import type { CommandPresetRecord } from '../../src/server/command-preset-store.js'

const codexPreset: CommandPresetRecord = {
  args: [],
  command: 'codex',
  displayName: 'Codex',
  env: {},
  id: 'codex',
  isBuiltin: true,
  resumeArgsTemplate: 'resume {session_id}',
  sessionIdCapture: {
    pattern: '~/.codex/sessions/**/*.jsonl',
    source: 'codex_session_jsonl_dir',
  },
  yoloArgsTemplate: null,
}

const tempDirs: string[] = []
const originalCodexHome = process.env.CODEX_HOME

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const createSessionStore = (sessionId: string): AgentSessionStore => ({
  clearLastSessionId: () => {},
  getLastSessionId: () => sessionId,
  setLastSessionId: () => {},
})

describe('agent run bootstrap', () => {
  test('does not snapshot sessions before spawning when a valid preset resume id is available', () => {
    const sessionId = '019dc277-0e8e-75c1-9794-94929426288e'
    const codexRoot = mkdtempSync(join(tmpdir(), 'hive-agent-bootstrap-codex-'))
    tempDirs.push(codexRoot)
    const codexHome = join(codexRoot, '.codex')
    process.env.CODEX_HOME = codexHome
    const sessionDir = join(codexHome, 'sessions', '2026', '04', '30')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(
      join(sessionDir, `rollout-${sessionId}.jsonl`),
      `${JSON.stringify({ payload: { cwd: '/tmp/no-such-codex-workspace', id: sessionId } })}\n`
    )
    const bootstrap = buildAgentRunBootstrap(
      {
        id: 'workspace-1',
        name: 'Workspace',
        path: '/tmp/no-such-codex-workspace',
      },
      'agent-1',
      {
        args: [],
        command: 'codex',
        commandPresetId: 'codex',
      },
      createSessionStore(sessionId),
      (id) => (id === 'codex' ? codexPreset : undefined)
    )

    expect(bootstrap.startConfig).toMatchObject({
      args: ['resume', sessionId],
      resumedSessionId: sessionId,
    })
    expect(bootstrap.sessionCaptureSnapshot).toBeUndefined()
  })

  test('clears a Codex session pointer when the session belongs to another agent', () => {
    const sessionId = '019dc277-0e8e-75c1-9794-94929426288e'
    const codexRoot = mkdtempSync(join(tmpdir(), 'hive-agent-bootstrap-bound-codex-'))
    tempDirs.push(codexRoot)
    const workspacePath = join(codexRoot, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    const codexHome = join(codexRoot, '.codex')
    process.env.CODEX_HOME = codexHome
    const sessionDir = join(codexHome, 'sessions', '2026', '04', '30')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(
      join(sessionDir, `rollout-${sessionId}.jsonl`),
      `${JSON.stringify({ payload: { cwd: workspacePath, id: sessionId } })}\n你是 Workspace 的 Alice（coder）。\n`
    )
    let cleared = false
    const bootstrap = buildAgentRunBootstrap(
      {
        id: 'workspace-1',
        name: 'Workspace',
        path: workspacePath,
      },
      'agent-1',
      {
        args: [],
        command: 'codex',
        commandPresetId: 'codex',
      },
      {
        clearLastSessionId: () => {
          cleared = true
        },
        getLastSessionId: () => sessionId,
        setLastSessionId: () => {},
      },
      (id) => (id === 'codex' ? codexPreset : undefined),
      {
        description: 'Coder',
        id: 'agent-1',
        name: 'Alice',
        pendingTaskCount: 0,
        role: 'coder',
        status: 'stopped',
        workspaceId: 'workspace-1',
      }
    )

    expect(cleared).toBe(true)
    expect(bootstrap.startConfig.resumedSessionId).toBeUndefined()
    expect(bootstrap.startConfig.args).toEqual([])
    expect(bootstrap.sessionCaptureSnapshot?.knownSessionIds).toEqual(new Set())
  })
})
