import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, test } from 'vitest'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import Database from '../../src/server/sqlite.js'

const exec = promisify(execFile)
const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
const cli = fileURLToPath(new URL('../../src/cli/hive.ts', import.meta.url))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const setup = async (online = false) => {
  const root = mkdtempSync(join(tmpdir(), 'hive-codex-repair-'))
  const dataDir = join(root, 'existing data')
  const project = join(root, '项目')
  const nativeRoot = join(root, 'native-home')
  mkdirSync(project)
  mkdirSync(join(nativeRoot, 'sessions'), { recursive: true })
  const store = createRuntimeStore({ dataDir })
  cleanups.push(async () => {
    await store.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })
  const workspace = store.createWorkspace(project, 'Existing workspace')
  const alice = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
  const bob = store.addWorker(workspace.id, { name: 'Bob', role: 'tester' })
  const context = {
    capture: {
      source: 'codex_session_jsonl_dir',
      pattern: join(nativeRoot, 'sessions', '**', '*.jsonl'),
    },
    cwd: project,
    platform: process.platform,
    knownSessionIds: [],
  }
  const database = () => new Database(join(dataDir, 'runtime.sqlite'), { fileMustExist: true })
  const db = database()
  try {
    for (const agent of [alice, bob])
      db.prepare(
        'INSERT INTO agent_session_contexts(workspace_id,agent_id,context_json,updated_at) VALUES(?,?,?,?)'
      ).run(workspace.id, agent.id, JSON.stringify(context), Date.now())
  } finally {
    db.close()
  }
  if (!online) await store.close()
  const session = (cwd = project) => {
    const id = randomUUID()
    const path = join(nativeRoot, 'sessions', `rollout-synthetic-${id}.jsonl`)
    const content = `${JSON.stringify({ type: 'session_meta', payload: { id, cwd, source: 'cli' } })}\n`
    writeFileSync(path, content)
    return { id, path, content }
  }
  const invoke = (id: string, agentId = alice.id, directory = dataDir) =>
    exec(
      process.execPath,
      [
        '--import',
        loader,
        cli,
        'data',
        'attach-codex-session',
        '--data-dir',
        directory,
        '--workspace-id',
        workspace.id,
        '--agent-id',
        agentId,
        '--session-id',
        id,
      ],
      { cwd: root, windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 }
    )
  const snapshot = () => {
    const db = database()
    try {
      return {
        bindings: db
          .prepare(
            'SELECT agent_id,last_session_id,updated_at FROM agent_sessions ORDER BY agent_id'
          )
          .all(),
        contexts: db
          .prepare(
            'SELECT agent_id,context_json,updated_at FROM agent_session_contexts ORDER BY agent_id'
          )
          .all() as Array<{ agent_id: string; context_json: string; updated_at: number }>,
        workers: db.prepare('SELECT id,last_session_id FROM workers ORDER BY id').all(),
      }
    } finally {
      db.close()
    }
  }
  return { root, project, store, workspace, alice, bob, invoke, session, snapshot, database }
}

test('explicit offline CLI attachment persists the exact unmarked native session and is idempotent without modifying native files', async () => {
  const f = await setup()
  const native = f.session()
  const result = JSON.parse((await f.invoke(native.id)).stdout)
  expect(result).toEqual({
    state: 'attached',
    workspace_id: f.workspace.id,
    agent_id: f.alice.id,
    session_id: native.id,
    native_files: 'unchanged',
  })
  const after = f.snapshot()
  expect(after.bindings).toEqual([
    { agent_id: f.alice.id, last_session_id: native.id, updated_at: expect.any(Number) },
  ])
  expect(after.workers).toContainEqual({ id: f.alice.id, last_session_id: native.id })
  const saved = after.contexts.find((row) => row.agent_id === f.alice.id)
  expect(JSON.parse(String(saved?.context_json))).toMatchObject({
    recoveredSessionId: native.id,
    cwd: f.project,
  })
  expect(JSON.parse((await f.invoke(native.id)).stdout).state).toBe('already_attached')
  expect(f.snapshot()).toEqual(after)
  expect(readFileSync(native.path, 'utf8')).toBe(native.content)
}, 60000)

test('the CLI refuses writes while another runtime owns the data directory', async () => {
  const f = await setup(true)
  const native = f.session()
  const before = f.snapshot()
  await expect(f.invoke(native.id)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('Another Hive runtime owns'),
  })
  expect(f.snapshot()).toEqual(before)
  expect(f.store.getWorkspaceSnapshot(f.workspace.id).summary.name).toBe('Existing workspace')
}, 30000)

test('missing native IDs and files for another cwd never change bindings', async () => {
  const f = await setup()
  const before = f.snapshot()
  await expect(f.invoke(randomUUID())).rejects.toMatchObject({ code: 1 })
  const other = f.session(join(f.root, 'other-workspace'))
  await expect(f.invoke(other.id)).rejects.toMatchObject({ code: 1 })
  expect(f.snapshot()).toEqual(before)
  expect(readFileSync(other.path, 'utf8')).toBe(other.content)
}, 60000)

test('an explicit attach cannot steal another member session or replace an existing different binding', async () => {
  const f = await setup()
  const first = f.session()
  await f.invoke(first.id)
  const before = f.snapshot()
  await expect(f.invoke(first.id, f.bob.id)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('another member'),
  })
  await expect(f.invoke(f.session().id)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('different session binding'),
  })
  expect(f.snapshot()).toEqual(before)
}, 60000)

test('attachment requires an existing member capture context and never initializes a missing data directory', async () => {
  const f = await setup()
  const native = f.session()
  const db = f.database()
  try {
    db.prepare('DELETE FROM agent_session_contexts WHERE agent_id=?').run(f.alice.id)
  } finally {
    db.close()
  }
  const before = f.snapshot()
  await expect(f.invoke(native.id)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('capture context'),
  })
  await expect(f.invoke(native.id, randomUUID())).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('Agent not found'),
  })
  const missing = join(f.root, 'not-created')
  await expect(f.invoke(native.id, f.alice.id, missing)).rejects.toMatchObject({ code: 1 })
  expect(existsSync(missing)).toBe(false)
  expect(f.snapshot()).toEqual(before)
}, 60000)
