import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import Database from '../../src/server/sqlite.js'
import { createCodeReviewFixture } from '../helpers/code-review-fixture.js'

const fixtures: Awaited<ReturnType<typeof createCodeReviewFixture>>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close()
})
const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error('Missing atomicity fixture value')
  return value
}
const setup = async () => {
  const f = await createCodeReviewFixture(false)
  fixtures.push(f)
  const marker = join(f.project, 'atomic-received.txt')
  const script = join(f.project, 'atomic-receiver.cjs')
  await writeFile(marker, '')
  await writeFile(
    script,
    `const fs=require('node:fs');process.stdin.setEncoding('utf8');process.stdin.on('data',text=>fs.appendFileSync(${JSON.stringify(marker)},text));process.stdin.resume()`
  )
  f.server.store.configureAgentLaunch(f.workspace.id, f.worker.id, {
    command: process.execPath,
    args: [script],
  })
  const root = join(f.project, '.hive', 'workflows')
  await mkdir(root, { recursive: true })
  await writeFile(
    join(root, 'atomic.json'),
    JSON.stringify({
      name: 'Atomic workflow',
      steps: [{ id: 'A', worker: 'Builder', task: 'ATOMIC_WORKFLOW_PAYLOAD' }],
    })
  )
  const db = new Database(join(f.dataDir, 'runtime.sqlite'))
  const counts = () => ({
    dispatches: (
      db
        .prepare('SELECT COUNT(*) AS n FROM dispatches WHERE workspace_id=?')
        .get(f.workspace.id) as { n: number }
    ).n,
    deliveries: (
      db
        .prepare('SELECT COUNT(*) AS n FROM message_deliveries WHERE workspace_id=?')
        .get(f.workspace.id) as { n: number }
    ).n,
  })
  const start = async () => {
    const response = await fetch(
      `${f.server.baseUrl}/api/ui/workspaces/${f.workspace.id}/workflows/runs`,
      {
        method: 'POST',
        headers: { cookie: f.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ workflow_id: 'atomic.json' }),
      }
    )
    expect(response.status).toBe(201)
    const created = (await response.json()) as { id: string }
    return () => required(f.server.store.workflows.get(f.workspace.id, created.id))
  }
  return { f, db, marker, counts, start }
}

test('failure inside dispatch ownership persistence rolls back the dispatch and its delivery together', async () => {
  const f = await setup()
  try {
    const before = f.counts()
    f.db.exec(`CREATE TRIGGER reject_workflow_binding BEFORE UPDATE ON workflow_runs
      WHEN json_extract(NEW.steps_json, '$[0].dispatchId') IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'injected ownership commit failure'); END`)
    const run = await f.start()
    expect(run()).toMatchObject({
      status: 'failed',
      steps: [expect.objectContaining({ dispatchId: null, status: 'failed' })],
    })
    expect(f.counts()).toEqual(before)
    expect(
      f.db.prepare('SELECT dispatch_id FROM workflow_step_attempts WHERE run_id=?').all(run().id)
    ).toEqual([{ dispatch_id: null }])
    expect(await readFile(f.marker, 'utf8')).toBe('')
  } finally {
    f.db.exec('DROP TRIGGER IF EXISTS reject_workflow_binding')
    f.db.close()
  }
}, 30000)

test('failure after ownership commit recovers the same dispatch after restart and writes its task only once', async () => {
  const f = await setup()
  try {
    const before = f.counts()
    f.db.exec(`CREATE TRIGGER reject_workflow_delivery BEFORE UPDATE ON message_deliveries
      WHEN NEW.kind='dispatch' AND NEW.state='attempting'
      BEGIN SELECT RAISE(ABORT, 'injected failure after ownership commit'); END`)
    const run = await f.start()
    const dispatchId = required(run().steps[0]?.dispatchId)
    expect(run().status).toBe('running')
    expect(f.counts()).toEqual({
      dispatches: before.dispatches + 1,
      deliveries: before.deliveries + 1,
    })
    expect(
      f.db
        .prepare(
          'SELECT dispatch_id FROM workflow_step_attempts WHERE run_id=? AND step_id=? AND attempt=1'
        )
        .get(run().id, 'A')
    ).toEqual({ dispatch_id: dispatchId })
    expect(f.f.server.store.dispatchDelivery.records.get(dispatchId)).toMatchObject({
      state: 'pending',
      attempt: 0,
      write_started: 0,
    })
    expect(await readFile(f.marker, 'utf8')).toBe('')
    await f.f.restart()
    f.db.exec('DROP TRIGGER reject_workflow_delivery')
    await f.f.server.store.workflows.refresh(f.f.workspace.id, run().id)
    await f.f.server.store.startAgent(f.f.workspace.id, f.f.worker.id, {
      hivePort: new URL(f.f.server.baseUrl).port,
    })
    await expect
      .poll(() => f.f.server.store.dispatchDelivery.records.get(dispatchId)?.state, {
        timeout: 8000,
      })
      .toBe('unknown')
    await expect
      .poll(() => readFile(f.marker, 'utf8'), { timeout: 8000 })
      .toContain('ATOMIC_WORKFLOW_PAYLOAD')
    await f.f.server.store.workflows.refresh(f.f.workspace.id, run().id)
    expect(run()).toMatchObject({
      status: 'interrupted',
      steps: [expect.objectContaining({ attempt: 1, dispatchId })],
    })
    expect(f.counts()).toEqual({
      dispatches: before.dispatches + 1,
      deliveries: before.deliveries + 1,
    })
    expect((await readFile(f.marker, 'utf8')).split('ATOMIC_WORKFLOW_PAYLOAD')).toHaveLength(2)
  } finally {
    f.db.exec('DROP TRIGGER IF EXISTS reject_workflow_delivery')
    f.db.close()
  }
}, 30000)
