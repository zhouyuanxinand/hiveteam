import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, expect, test } from 'vitest'
import { createDispatchLedgerStore } from '../../src/server/dispatch-ledger-store.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { applySchemaVersion62 } from '../../src/server/sqlite-schema-v62.js'
import { createTeamReviewStore } from '../../src/server/team-review-store.js'
import { createWorkspaceStore } from '../../src/server/workspace-store.js'
import type { TeamReviewRecord } from '../../src/shared/team-review.js'

const roots: string[] = [],
  databases: Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const root of roots.splice(0)) {
    if (dirname(root) !== resolve(tmpdir())) throw new Error('Unexpected fixture path')
    rmSync(root, { recursive: true, force: true })
  }
})
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-review-migration-'))
  roots.push(root)
  const path = join(root, 'runtime.sqlite')
  writeFileSync(
    path,
    gunzipSync(
      readFileSync(new URL('../fixtures/sqlite-legacy/runtime-v59.sqlite.gz', import.meta.url))
    )
  )
  const db = new Database(path)
  databases.push(db)
  return { db, root }
}

test('legacy reports and receipts survive ancestry migration and nested reviews keep one workspace-scoped root', () => {
  const { db, root } = setup()
  const reports = db.prepare('SELECT * FROM report_outbox ORDER BY id').all()
  initializeRuntimeDatabase(db)
  const ledger = createDispatchLedgerStore(db),
    workspaces = createWorkspaceStore(db, [])
  const source = ledger
    .listWorkspaceDispatches('legacy-workspace')
    .find((dispatch) => dispatch.status === 'reported')
  if (!source) throw new Error('Legacy reported dispatch missing')
  expect(
    db
      .prepare('SELECT root_dispatch_id,parent_dispatch_id FROM dispatches WHERE id=?')
      .get(source.id)
  ).toEqual({ root_dispatch_id: source.id, parent_dispatch_id: null })
  const worker = workspaces.addWorker('legacy-workspace', { name: 'Reviewer', role: 'reviewer' })
  const first = ledger.createDispatch({
    workspaceId: 'legacy-workspace',
    toAgentId: worker.id,
    text: 'Review source',
    parentDispatchId: source.id,
  })
  const second = ledger.createDispatch({
    workspaceId: 'legacy-workspace',
    toAgentId: worker.id,
    text: 'Review follow-up',
    parentDispatchId: first.id,
  })
  expect(ledger.getDispatchById('legacy-workspace', second.id)).toMatchObject({
    parentDispatchId: first.id,
    rootDispatchId: source.id,
  })
  const other = workspaces.createWorkspace(root, 'Other')
  expect(() =>
    ledger.createDispatch({
      workspaceId: other.id,
      toAgentId: worker.id,
      text: 'Cross workspace',
      parentDispatchId: source.id,
    })
  ).toThrow('Parent dispatch not found')
  expect(ledger.listWorkspaceDispatches(other.id)).toEqual([])
  expect(db.prepare('SELECT * FROM report_outbox ORDER BY id').all()).toEqual(reports)
  expect(db.pragma('foreign_key_check')).toEqual([])
})

test('a changed report rolls back review ownership and member admission together', () => {
  const { db } = setup()
  initializeRuntimeDatabase(db)
  const workspaces = createWorkspaceStore(db, []),
    ledger = createDispatchLedgerStore(db),
    reviews = createTeamReviewStore(db)
  const source = ledger
    .listWorkspaceDispatches('legacy-workspace')
    .find((dispatch) => dispatch.status === 'reported')
  if (!source) throw new Error('Legacy report missing')
  const before = workspaces.listWorkers('legacy-workspace')
  const record = (workerId: string): TeamReviewRecord => ({
    id: randomUUID(),
    workspace_id: 'legacy-workspace',
    source_dispatch_id: source.id,
    source_report_revision: source.reportRevision + 1,
    source_head_sha: 'a'.repeat(40),
    source_base_sha: 'b'.repeat(40),
    repository_id: 'c'.repeat(64),
    baseline_kind: 'dispatch_base',
    focus: 'Review API',
    command_preset_id: 'fixture',
    requested_by: 'legacy-workspace:orchestrator',
    reviewer_id: workerId,
    review_dispatch_id: null,
    created_at: Date.now(),
    last_error: null,
  })
  expect(() =>
    workspaces.addWorkers(
      'legacy-workspace',
      [
        {
          name: 'Temporary reviewer',
          role: 'reviewer',
          spawnedByAgentId: 'legacy-workspace:orchestrator',
        },
      ],
      (workers) => {
        const worker = workers[0]
        if (!worker) throw new Error('Missing worker')
        reviews.create(record(worker.id))
      }
    )
  ).toThrow('source report changed')
  expect(workspaces.listWorkers('legacy-workspace')).toEqual(before)
  expect(db.prepare('SELECT * FROM team_review_requests').all()).toEqual([])
  expect(db.prepare("SELECT * FROM workers WHERE name='Temporary reviewer'").all()).toEqual([])
})

test('a schema 62 DDL failure rolls back ancestry, pinned checkout fields and existing dispatch values', () => {
  const db = new Database(':memory:')
  databases.push(db)
  db.exec(`CREATE TABLE workspaces(id TEXT PRIMARY KEY); CREATE TABLE workers(id TEXT PRIMARY KEY);
    CREATE TABLE dispatches(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL);
    CREATE TABLE worker_worktrees(worker_id TEXT PRIMARY KEY);
    INSERT INTO dispatches VALUES('original','workspace');
    CREATE TABLE team_review_requests(collision TEXT);`)
  expect(() => applySchemaVersion62(db)).toThrow('already exists')
  expect(db.prepare('SELECT * FROM dispatches').all()).toEqual([
    { id: 'original', workspace_id: 'workspace' },
  ])
  expect(db.pragma('table_info(worker_worktrees)')).toEqual([
    expect.objectContaining({ name: 'worker_id' }),
  ])
  db.exec('DROP TABLE team_review_requests')
  applySchemaVersion62(db)
  expect(db.prepare('SELECT * FROM dispatches').all()).toEqual([
    {
      id: 'original',
      workspace_id: 'workspace',
      parent_dispatch_id: null,
      root_dispatch_id: 'original',
    },
  ])
})
