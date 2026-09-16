import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, expect, test } from 'vitest'

import { createAgentRunStore } from '../../src/server/agent-run-store.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

const tempDirs: string[] = []
const databases: Database.Database[] = []

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const openStore = (path: string) => {
  const db = new Database(path)
  databases.push(db)
  initializeRuntimeDatabase(db)
  return { db, store: createAgentRunStore(db) }
}

const createFixture = () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-shutdown-run-store-'))
  tempDirs.push(dataDir)
  const path = join(dataDir, 'runtime.sqlite')
  const { db, store } = openStore(path)
  store.saveLaunchConfig('workspace', 'agent', { command: process.execPath })
  return { db, path, store }
}

test.each([
  false,
  true,
])('never recovers an older active run when a newer run has completed (checkpoint: %s)', (checkpoint) => {
  const { store } = createFixture()
  store.insertAgentRun('old', 'agent', 1000, 123, 'running')
  if (checkpoint) store.checkpointShutdownRuns(['old'])
  // Equal timestamps are possible when starts complete in the same millisecond.
  store.insertAgentRun('new', 'agent', 1000, 124, 'exited', 0, 1001)

  expect(store.listInterruptedRuns()).toEqual([])
})

test.each([0, 1])('shutdown exit code %i preserves the fast-exit guard count', (exitCode) => {
  const { store } = createFixture()
  for (let index = 0; index < 2; index += 1) {
    store.insertAgentRun(`failed-${index}`, 'agent', 1000 + index, 123, 'running')
    store.updatePersistedRun(`failed-${index}`, 'error', 1, 2000 + index)
  }
  store.insertAgentRun('shutdown', 'agent', 3000, 123, 'running')
  store.checkpointShutdownRuns(['shutdown'])
  store.updatePersistedRun('shutdown', exitCode === 0 ? 'exited' : 'error', exitCode, 3001)

  expect(store.listInterruptedRuns()).toEqual([
    expect.objectContaining({ consecutiveFastExits: 2, runId: 'shutdown' }),
  ])
})

test('retains crash recovery intent if a reopened platform closes before resuming', () => {
  const { db, path, store } = createFixture()
  store.insertAgentRun('crashed', 'agent', 1000, 123, 'running')
  db.close()

  const firstReopen = openStore(path)
  firstReopen.store.markUnfinishedRunsStale(2000)
  expect(firstReopen.store.listAgentRuns('agent')).toEqual([
    expect.objectContaining({ endedAt: 2000, runId: 'crashed', status: 'error' }),
  ])
  firstReopen.db.close()

  const secondReopen = openStore(path)
  expect(secondReopen.store.listInterruptedRuns()).toEqual([
    expect.objectContaining({ runId: 'crashed', workspaceId: 'workspace' }),
  ])
})

test('failed persistence of a new run leaves the old shutdown checkpoint recoverable', () => {
  const { db, store } = createFixture()
  store.insertAgentRun('shutdown', 'agent', 1000, 123, 'running')
  store.checkpointShutdownRuns(['shutdown'])
  store.updatePersistedRun('shutdown', 'exited', 0, 2000)
  db.exec(`
    CREATE TRIGGER reject_checkpoint_consumption BEFORE UPDATE OF resume_on_restart ON agent_runs
    WHEN OLD.resume_on_restart = 1 AND NEW.resume_on_restart = 0
    BEGIN SELECT RAISE(ABORT, 'checkpoint write failed'); END;
  `)

  expect(() => store.insertAgentRun('new', 'agent', 3000, 124, 'starting')).toThrow(
    'checkpoint write failed'
  )
  expect(store.listAgentRuns('agent')).toEqual([
    expect.objectContaining({ runId: 'shutdown', status: 'exited' }),
  ])
  expect(store.listInterruptedRuns()).toEqual([expect.objectContaining({ runId: 'shutdown' })])
})

test.each([
  'starting',
  'error',
] as const)('a %s resume failure remains recoverable and counts toward the fast-exit limit', (status) => {
  const { db, path, store } = createFixture()
  store.insertAgentRun('shutdown', 'agent', 1000, 123, 'running')
  store.checkpointShutdownRuns(['shutdown'])
  store.updatePersistedRun('shutdown', 'exited', 0, 2000)
  for (let index = 0; index < 3; index += 1) {
    const id = `resume-${index}`
    store.insertAgentRun(id, 'agent', 3000 + index * 1000, 124, status)
    store.updatePersistedRun(id, 'error', 1, 3100 + index * 1000)
    expect(store.listInterruptedRuns()).toEqual([
      expect.objectContaining({ runId: id, consecutiveFastExits: index + 1 }),
    ])
  }
  db.close()
  expect(openStore(path).store.listInterruptedRuns()).toEqual([
    expect.objectContaining({ runId: 'resume-2', consecutiveFastExits: 3 }),
  ])
})

test('migrates a v44 database without making previously completed runs recovery candidates', () => {
  const { db, path, store } = createFixture()
  store.insertAgentRun('active', 'agent', 1000, 123, 'running')
  store.saveLaunchConfig('workspace', 'completed-agent', { command: process.execPath })
  store.insertAgentRun('completed', 'completed-agent', 1000, 124, 'exited', 0, 2000)
  db.exec(`
    DROP INDEX idx_agent_runs_agent_started;
    ALTER TABLE agent_runs DROP COLUMN resume_on_restart;
    DELETE FROM schema_version WHERE version >= 45;
  `)
  db.close()

  const reopened = openStore(path)
  expect(reopened.store.listInterruptedRuns()).toEqual([
    expect.objectContaining({ runId: 'active' }),
  ])
  reopened.store.checkpointShutdownRuns(['active'])
  reopened.store.updatePersistedRun('active', 'exited', 0, 3000)
  reopened.db.close()

  const again = openStore(path)
  expect(again.store.listInterruptedRuns()).toEqual([
    expect.objectContaining({ runId: 'active', status: 'exited' }),
  ])
  expect(again.store.listAgentRuns('completed-agent')).toEqual([
    expect.objectContaining({ runId: 'completed', status: 'exited' }),
  ])
})
