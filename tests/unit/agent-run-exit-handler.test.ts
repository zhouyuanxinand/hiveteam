import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { clearResumedSessionIfInvalid } from '../../src/server/agent-run-exit-handler.js'

const tempDirs: string[] = []
const originalCodexHome = process.env.CODEX_HOME

const createCodexSession = (cwd: string, sessionId: string) => {
  const root = mkdtempSync(join(tmpdir(), 'hive-exit-handler-codex-'))
  const codexHome = join(root, '.codex')
  const sessionDir = join(codexHome, 'sessions', '2026', '04', '30')
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(
    join(sessionDir, `rollout-${sessionId}.jsonl`),
    `${JSON.stringify({ payload: { cwd, id: sessionId } })}\n`
  )
  process.env.CODEX_HOME = codexHome
  tempDirs.push(root)
  return codexHome
}

const createContext = (workspacePath: string, sessionId: string, cleared: string[]) => ({
  agentId: 'agent-1',
  sessionStore: {
    clearLastSessionId: (workspaceId: string, agentId: string) => {
      cleared.push(`${workspaceId}:${agentId}`)
    },
  } as never,
  startConfig: {
    resumedSessionId: sessionId,
    sessionIdCapture: {
      pattern: '~/.codex/sessions/**/*.jsonl',
      source: 'codex_session_jsonl_dir' as const,
    },
  },
  workspace: { id: 'workspace-1', name: 'Workspace', path: workspacePath },
})

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('resumed session cleanup', () => {
  test('keeps a Codex session after a failed resume when the native session still exists', () => {
    const workspacePath = '/tmp/codex-session-still-exists'
    const sessionId = '019dc277-0e8e-75c1-9794-94929426288e'
    createCodexSession(workspacePath, sessionId)
    const cleared: string[] = []

    clearResumedSessionIfInvalid(createContext(workspacePath, sessionId, cleared), 1)

    expect(cleared).toEqual([])
  })

  test('clears a Codex session pointer when the native session is gone', () => {
    const workspacePath = '/tmp/codex-session-is-gone'
    const sessionId = '019dc277-0e8e-75c1-9794-94929426288e'
    const codexHome = createCodexSession(workspacePath, sessionId)
    rmSync(codexHome, { force: true, recursive: true })
    const cleared: string[] = []

    clearResumedSessionIfInvalid(createContext(workspacePath, sessionId, cleared), 1)

    expect(cleared).toEqual(['workspace-1:agent-1'])
  })
})
