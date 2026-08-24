import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { createAgentRunStore } from '../../src/server/agent-run-store.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
  vi.restoreAllMocks()
})

describe('agent run store args validation', () => {
  test('carries consecutive fast-exit counts across runs and resets after a normal exit', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-fast-exit-counts-'))
    tempDirs.push(dataDir)
    const db = new Database(join(dataDir, 'runtime.sqlite'))
    initializeRuntimeDatabase(db)
    const store = createAgentRunStore(db)
    const agentId = 'agent-fast-exit'
    const baseStartedAt = Date.now()

    for (let index = 1; index <= 3; index += 1) {
      const startedAt = baseStartedAt + index
      store.insertAgentRun(`run-${index}`, agentId, startedAt, 123, 'running')
      store.updatePersistedRun(`run-${index}`, 'error', 1, startedAt + 100)
    }

    const beforeReset = db
      .prepare(
        'SELECT consecutive_fast_exits FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT 1'
      )
      .get(agentId) as { consecutive_fast_exits: number }
    expect(beforeReset.consecutive_fast_exits).toBe(3)

    const normalStartedAt = baseStartedAt + 10
    store.insertAgentRun('run-normal', agentId, normalStartedAt, 123, 'running')
    store.updatePersistedRun('run-normal', 'exited', 0, normalStartedAt + 11_000)

    const afterReset = db
      .prepare('SELECT consecutive_fast_exits FROM agent_runs WHERE run_id = ?')
      .get('run-normal') as { consecutive_fast_exits: number }
    expect(afterReset.consecutive_fast_exits).toBe(0)
    db.close()
  })

  test('non-string-array args_json falls back to empty args and warns', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-bad-args-shape-'))
    tempDirs.push(dataDir)
    const db = new Database(join(dataDir, 'runtime.sqlite'))
    db.exec(`CREATE TABLE agent_launch_configs (
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      command TEXT NOT NULL,
      args_json TEXT NOT NULL,
      command_preset_id TEXT,
      interactive_command TEXT,
      preset_augmentation_disabled INTEGER NOT NULL DEFAULT 0,
      resume_args_template TEXT,
      session_id_capture_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, agent_id)
    );`)
    db.prepare(
      `INSERT INTO agent_launch_configs (
         workspace_id,
         agent_id,
         command,
         args_json,
         command_preset_id,
         interactive_command,
         preset_augmentation_disabled,
         resume_args_template,
         session_id_capture_json,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'ws-1',
      'agent-1',
      '/bin/bash',
      '[1,2]',
      null,
      null,
      0,
      null,
      null,
      Date.now(),
      Date.now()
    )

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const configs = createAgentRunStore(db).listLaunchConfigs()

    expect(configs[0]?.config.args).toEqual([])
    expect(warnSpy).toHaveBeenCalled()
    db.close()
  })
})
