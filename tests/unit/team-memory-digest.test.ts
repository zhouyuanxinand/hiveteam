import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'
import { buildAgentStartupInstructions } from '../../src/server/agent-startup-instructions.js'
import { buildWorkerDispatchPayload } from '../../src/server/agent-stdin-dispatcher.js'
import { createSettingsStore } from '../../src/server/settings-store.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import {
  createTeamMemoryDigestProvider,
  setWorkspaceMemoryEnabled,
} from '../../src/server/team-memory-digest.js'
import { createTeamMemoryStore } from '../../src/server/team-memory-store.js'

const databases: Database[] = []

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close()
})

const createFixture = () => {
  const db = new Database(':memory:')
  databases.push(db)
  initializeRuntimeDatabase(db)
  const memory = createTeamMemoryStore(db)
  const settings = createSettingsStore(db)
  return { memory, provider: createTeamMemoryDigestProvider(memory, settings), settings }
}

describe('team memory digest', () => {
  test('selects relevant memory, records injection, and respects the workspace switch', () => {
    const { memory, provider, settings } = createFixture()
    const workspaceId = 'workspace-1'
    const relevant = memory.create(workspaceId, {
      body: 'Authentication changes must preserve the legacy session cookie.',
      kind: 'decision',
      tags: ['auth'],
    })
    memory.create(workspaceId, {
      body: 'The documentation accent color is blue.',
      kind: 'preference',
      tags: ['docs'],
    })

    const digest = provider.forDispatch(workspaceId, 'worker-1', 'Implement authentication flow')

    expect(digest).toContain('<hive-memory context="dispatch">')
    expect(digest).toContain('legacy session cookie')
    expect(memory.get(workspaceId, relevant.id)?.lastInjectedAt).not.toBeNull()

    setWorkspaceMemoryEnabled(settings, workspaceId, false)
    expect(provider.forDispatch(workspaceId, 'worker-1', 'authentication')).toBe('')
  })

  test('keeps injected context within budget and places it before the worker reminder', () => {
    const { memory, provider } = createFixture()
    const workspaceId = 'workspace-2'
    memory.create(workspaceId, {
      body: `Security constraint: ${'verify input '.repeat(280)}`,
      kind: 'pitfall',
      tags: ['security'],
    })

    const digest = provider.forDispatch(workspaceId, 'worker-2', 'security input')
    expect(digest.length).toBeLessThanOrEqual(1500)

    const payload = buildWorkerDispatchPayload(
      'Orchestrator',
      'Security reviewer',
      'd-1',
      'Audit input',
      digest
    )
    expect(payload.indexOf('<hive-memory')).toBeGreaterThan(payload.indexOf('Audit input'))
    expect(payload.indexOf('<hive-system-reminder>')).toBeGreaterThan(
      payload.indexOf('</hive-memory>')
    )
  })

  test('startup instructions accept a memory digest without changing the three-state agent model', () => {
    const instructions = buildAgentStartupInstructions({
      agent: {
        description: 'Implement scoped changes',
        id: 'worker-3',
        name: 'Alice',
        pendingTaskCount: 0,
        role: 'coder',
        status: 'idle',
        workspaceId: 'workspace-3',
      },
      memoryDigest: '<hive-memory context="startup">\n- [decision] Use pnpm.\n</hive-memory>',
      workspace: { id: 'workspace-3', name: 'Alpha', path: '/tmp/alpha' },
    })

    expect(instructions).toContain('<hive-memory context="startup">')
    expect(instructions).toContain('Use pnpm.')
  })
})
