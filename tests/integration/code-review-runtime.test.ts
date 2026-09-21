import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'
import { readCodeReviewVersion } from '../../src/server/code-review-git.js'
import { createExecutionPolicyStore } from '../../src/server/execution-policy-store.js'
import { runGit } from '../../src/server/git-command.js'
import { stampLoopbackHeaders } from '../../src/server/remote-loopback-auth.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createTeamMailboxBroker } from '../../src/server/team-mailbox-broker.js'
import type { CodeReviewRecord } from '../../src/shared/code-review.js'
import { commitReviewFixture, createCodeReviewFixture } from '../helpers/code-review-fixture.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const setup = async (isolated = true) => {
  const f = await createCodeReviewFixture(isolated)
  cleanups.push(f.close)
  return f
}
const approval = async (f: Awaited<ReturnType<typeof setup>>) => {
  const view = await f.context()
  const body = {
    request_id: randomUUID(),
    version: view.version,
    conclusion: 'approve',
    summary: 'The exact diff was reviewed.',
  }
  const response = await f.request('', body)
  expect(response.status).toBe(201)
  const record = (await response.json()) as CodeReviewRecord
  return {
    body,
    record,
    accept: () => f.request(`/${record.id}/accept`, { version: view.version }),
  }
}

describe('version-bound code reviews', { timeout: 60_000 }, () => {
  test('records separate desktop acceptance, preserves immutable evidence across restart and deduplicates retries', async () => {
    const f = await setup()
    const context = await f.context()
    expect(context.version).toMatchObject({
      source_sha: f.source,
      base_sha: f.baseline,
      report_revision: 1,
    })
    expect(context.patch).toContain('+delivered')
    expect(context.baseline_kind).toBe('target_head')
    const a = await approval(f)
    expect(a.record).toMatchObject({
      reviewer_id: 'local_user',
      accepted_at: null,
      reviewer_run_id: null,
    })
    expect((await f.context()).accepted).toBe(false)
    expect((await f.request('', a.body)).status).toBe(201)
    expect((await f.context()).reviews).toHaveLength(1)
    expect((await f.request('', { ...a.body, summary: 'different content' })).status).toBe(409)
    expect((await a.accept()).status).toBe(200)
    const accepted = await f.context()
    expect(accepted.accepted).toBe(true)
    expect(accepted.reviews[0]?.accepted_by).toBe('local_user')
    expect(f.server.store.getDispatch(f.workspace.id, f.dispatch.id)?.acceptedAt).toBeNull()
    expect(
      (await f.server.store.verifications.view(f.workspace.id, f.dispatch.id)).runs
    ).toHaveLength(0)
    expect((await a.accept()).status).toBe(200)
    expect((await f.context()).reviews[0]?.accepted_at).toBe(accepted.reviews[0]?.accepted_at)
    await f.restart()
    expect((await f.context()).reviews).toEqual(accepted.reviews)
    expect((await f.context()).accepted).toBe(true)
    const negative = await f.request('', {
      ...a.body,
      request_id: randomUUID(),
      conclusion: 'changes_requested',
      summary: 'A missing regression case was found.',
    })
    expect(negative.status).toBe(201)
    expect((await f.context()).accepted).toBe(false)
    expect((await a.accept()).status).toBe(409)
    const record = (await negative.json()) as CodeReviewRecord
    expect((await f.request(`/${record.id}/accept`, { version: a.body.version })).status).toBe(409)
    expect((await f.context()).reviews[1]).toMatchObject({
      stale_reason: 'superseded',
      accepted_at: accepted.reviews[0]?.accepted_at,
    })
  })

  test('rejects old-page acceptance and submission after baseline, source, dirty state or report changes', async () => {
    const f = await setup()
    const a = await approval(f)
    expect((await a.accept()).status).toBe(200)
    await writeFile(join(f.project, 'independent.txt'), 'another delivery\n')
    const target = await commitReviewFixture(f.project, 'Advance target')
    expect((await f.context()).version?.base_sha).toBe(target)
    expect((await f.context()).reviews[0]?.stale_reason).toBe('baseline_changed')
    expect((await a.accept()).status).toBe(409)
    expect((await f.request('', { ...a.body, request_id: randomUUID() })).status).toBe(409)
    const b = await approval(f)
    expect((await b.accept()).status).toBe(200)
    await writeFile(join(f.sourcePath, 'value.txt'), 'uncommitted\n')
    expect((await f.context()).reviews[0]?.stale_reason).toBe('uncommitted_changes')
    expect((await b.accept()).status).toBe(409)
    await commitReviewFixture(f.sourcePath, 'Change source')
    expect((await f.context()).reviews[0]?.stale_reason).toBe('code_changed')
    expect((await b.accept()).status).toBe(409)
    const c = await approval(f)
    await f.server.store.startAgent(f.workspace.id, f.worker.id, {
      hivePort: new URL(f.server.baseUrl).port,
    })
    f.server.store.sendDispatchFeedback(
      f.workspace.id,
      f.dispatch.id,
      'Revise the report for the new commit'
    )
    f.server.store.reportTask(f.workspace.id, f.worker.id, {
      dispatchId: f.dispatch.id,
      outcome: 'success',
      text: 'Revised report',
    })
    expect((await f.context()).reviews[0]?.stale_reason).toBe('report_changed')
    expect((await c.accept()).status).toBe(409)
    expect((await f.context()).reviews).toHaveLength(3)
  })

  test('database write failures cannot create evidence or partially accept it', async () => {
    const f = await setup()
    const version = (await f.context()).version
    const db = new Database(join(f.dataDir, 'runtime.sqlite'))
    try {
      db.exec(
        "CREATE TRIGGER fail_review_insert BEFORE INSERT ON dispatch_code_reviews BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END"
      )
      expect(
        (
          await f.request('', {
            request_id: randomUUID(),
            version,
            conclusion: 'approve',
            summary: 'Review',
          })
        ).status
      ).toBe(500)
      expect((await f.context()).reviews).toHaveLength(0)
      db.exec('DROP TRIGGER fail_review_insert')
      const a = await approval(f)
      db.exec(
        "CREATE TRIGGER fail_review_accept BEFORE UPDATE ON dispatch_code_reviews BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END"
      )
      expect((await a.accept()).status).toBe(500)
      expect((await f.context()).reviews[0]?.accepted_at).toBeNull()
      expect(f.server.store.getDispatch(f.workspace.id, f.dispatch.id)?.acceptedAt).toBeNull()
      db.exec('DROP TRIGGER fail_review_accept')
      expect((await a.accept()).status).toBe(200)
    } finally {
      db.close()
    }
  })

  test('keeps shared dispatch baselines and distinguishes a cloned repository with the same commits', async () => {
    const f = await setup(false)
    const view = await f.context()
    expect(view.baseline_kind).toBe('dispatch_base')
    expect(view.version, JSON.stringify(view)).toMatchObject({
      source_sha: f.source,
      base_sha: f.baseline,
    })
    const clone = join(f.root, 'clone')
    await runGit(f.root, ['clone', '--no-hardlinks', f.project, clone])
    const version = await readCodeReviewVersion({
      sourcePath: clone,
      targetPath: clone,
      reportRevision: 1,
      dispatchBase: f.baseline,
    })
    expect(version.version?.source_sha).toBe(view.version?.source_sha)
    expect(version.version?.repository_id).not.toBe(view.version?.repository_id)
    expect(
      (
        await f.request('', {
          request_id: randomUUID(),
          version: version.version,
          conclusion: 'approve',
          summary: 'Wrong repository',
        })
      ).status
    ).toBe(409)
  })

  test('migration does not promote historical report text and remains safe on repeated initialization', async () => {
    const f = await setup()
    await f.closeServer()
    const db = new Database(join(f.dataDir, 'runtime.sqlite'))
    try {
      db.exec('DROP TABLE dispatch_code_reviews; DELETE FROM schema_version WHERE version = 53')
      initializeRuntimeDatabase(db)
      initializeRuntimeDatabase(db)
      expect(db.prepare('SELECT count(*) AS count FROM dispatch_code_reviews').get()).toEqual({
        count: 0,
      })
      expect(
        db
          .prepare('SELECT report_revision, report_text FROM dispatches WHERE id = ?')
          .get(f.dispatch.id)
      ).toMatchObject({ report_revision: 1, report_text: 'Ready for review' })
      expect(
        db.prepare('SELECT count(*) AS count FROM schema_version WHERE version = 53').get()
      ).toEqual({ count: 1 })
    } finally {
      db.close()
    }
  })

  test('non-Git work remains usable and exposes an explicit review-unavailable result', async () => {
    const f = await setup()
    const path = join(f.root, 'plain')
    await mkdir(path)
    const workspace = f.server.store.createWorkspace(path, 'Plain documents')
    const worker = f.server.store.addWorker(workspace.id, { name: 'Writer', role: 'custom' })
    f.server.store.configureAgentLaunch(workspace.id, worker.id, {
      command: process.execPath,
      args: ['-e', 'process.stdin.resume()'],
    })
    const dispatch = await f.server.store.dispatchTask(
      workspace.id,
      worker.id,
      'Research a concept'
    )
    f.server.store.reportTask(workspace.id, worker.id, {
      dispatchId: dispatch.id,
      text: 'Findings',
      outcome: 'success',
    })
    const view = await f.server.store.codeReviews.view(workspace.id, dispatch.id)
    expect(view.version).toBeNull()
    expect(view.unavailable_reason).toBeTruthy()
    expect(view.accepted).toBe(false)
    expect(f.server.store.acceptDispatchReport(workspace.id, dispatch.id, 1).acceptedAt).toEqual(
      expect.any(Number)
    )
  })

  test('remote access remains scoped and read-only, and coder credentials cannot impersonate a reviewer', async () => {
    const f = await setup()
    const a = await approval(f)
    const device = f.server.store.remote.devices.insert({
      id: randomUUID(),
      name: 'Review phone',
      keys: { d2p: new Uint8Array(32).fill(1), p2d: new Uint8Array(32).fill(2) },
      devicePublicKey: new Uint8Array(32).fill(3),
    })
    const headers = stampLoopbackHeaders(
      { 'content-type': 'application/json' },
      f.server.store.getRemoteTunnelSecret(),
      device.id
    )
    expect((await f.request('/context', undefined, headers)).status).toBe(403)
    f.server.store.remote.permissions.setReadScopes(device.id, [f.workspace.id])
    expect((await f.request('/context', undefined, headers)).status).toBe(200)
    expect((await f.request('', { ...a.body, request_id: randomUUID() }, headers)).status).toBe(403)
    expect(
      (await f.request(`/${a.record.id}/accept`, { version: a.body.version }, headers)).status
    ).toBe(403)
    await f.server.store.startAgent(f.workspace.id, f.worker.id, {
      hivePort: new URL(f.server.baseUrl).port,
    })
    const coder = await fetch(`${f.server.baseUrl}/api/team/review/context`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: f.workspace.id,
        from_agent_id: f.worker.id,
        token: f.server.store.peekAgentToken(f.worker.id),
        dispatch_id: f.dispatch.id,
      }),
    })
    expect(coder.status).toBe(403)
    expect((await f.request('', a.body, {})).status).toBe(403)
    expect((await f.context()).accepted).toBe(false)
  })

  test('reviewer CLI reads immutable files through a scoped mailbox, records identity and cannot accept or publish', async () => {
    const f = await setup()
    await writeFile(join(f.sourcePath, '.env.local'), 'SYNTHETIC_SECRET=hidden\n')
    await writeFile(join(f.sourcePath, 'binary.dat'), Buffer.from([0, 1, 2]))
    await commitReviewFixture(f.sourcePath, 'Add bounded read fixtures')
    const originalBlob = (await runGit(f.sourcePath, ['rev-parse', 'HEAD:value.txt'])).trim()
    const replacementPath = join(f.root, 'replacement.txt')
    await writeFile(replacementPath, 'REPLACE_REF_OVERLAY\n')
    const replacementBlob = (
      await runGit(f.sourcePath, ['hash-object', '-w', replacementPath])
    ).trim()
    await runGit(f.sourcePath, ['replace', originalBlob, replacementBlob])
    const reviewer = f.server.store.addWorker(f.workspace.id, {
      name: 'Reviewer',
      role: 'reviewer',
    })
    f.server.store.configureAgentLaunch(f.workspace.id, reviewer.id, {
      command: process.execPath,
      args: ['-e', 'process.stdin.resume()'],
    })
    const run = await f.server.store.startAgent(f.workspace.id, reviewer.id, {
      hivePort: new URL(f.server.baseUrl).port,
    })
    const token = f.server.store.peekAgentToken(reviewer.id)
    if (!token) throw new Error('Missing reviewer token')
    const broker = await createTeamMailboxBroker({
      root: join(f.dataDir, 'review-mailbox'),
      workspaceId: f.workspace.id,
      agentId: reviewer.id,
      token,
      hivePort: new URL(f.server.baseUrl).port,
      isActive: () => f.server.store.getLiveRun(run.runId).status === 'running',
    })
    cleanups.push(broker.close)
    const cli = (args: string[]) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', 'bin/team', 'review', ...args], {
          env: {
            ...process.env,
            HIVE_TEAM_MAILBOX: broker.path,
            HIVE_PORT: '1',
            HIVE_PROJECT_ID: f.workspace.id,
            HIVE_AGENT_ID: reviewer.id,
            HIVE_AGENT_TOKEN: 'broker-injects-real-token',
          },
          windowsHide: true,
        })
        let stdout = '',
          stderr = ''
        child.stdout.on('data', (value) => {
          stdout += String(value)
        })
        child.stderr.on('data', (value) => {
          stderr += String(value)
        })
        child.on('error', reject)
        child.on('close', (code) => resolve({ code, stdout, stderr }))
        child.stdin.end()
      })
    const result = await cli(['context', '--dispatch', f.dispatch.id])
    expect(result.code, result.stderr).toBe(0)
    const context = JSON.parse(result.stdout)
    expect(context.patch).toContain('delivered')
    expect(context.patch).not.toContain('SYNTHETIC_SECRET')
    expect(context.patch).not.toContain('REPLACE_REF_OVERLAY')
    expect(context.omitted_sensitive_files).toBe(1)
    const version = JSON.stringify(context.version)
    for (const [side, content] of [
      ['source', 'delivered\n'],
      ['base', 'original\n'],
    ]) {
      const file = await cli([
        'file',
        '--dispatch',
        f.dispatch.id,
        '--version',
        version,
        '--path',
        'value.txt',
        '--side',
        side ?? 'source',
      ])
      expect(file.code, file.stderr).toBe(0)
      expect(JSON.parse(file.stdout).content).toBe(content)
    }
    for (const path of ['../value.txt', '.env.local', 'binary.dat', '.git/config']) {
      const blocked = await cli([
        'file',
        '--dispatch',
        f.dispatch.id,
        '--version',
        version,
        '--path',
        path,
      ])
      expect(blocked.code).toBe(1)
      expect(blocked.stdout).not.toContain('SYNTHETIC_SECRET')
    }
    const args = [
      'submit',
      '--dispatch',
      f.dispatch.id,
      '--version',
      version,
      '--conclusion',
      'approve',
      'The exact source and baseline were inspected.',
    ]
    const unsafe = await cli(args)
    expect(unsafe.code).toBe(1)
    expect(unsafe.stderr).toContain('read-only')
    // Synthetic snapshot isolates policy plumbing. This does not test an OS sandbox.
    const db = new Database(join(f.dataDir, 'runtime.sqlite'))
    try {
      const policies = createExecutionPolicyStore(db)
      const snapshot = policies.forRun(run.runId)
      if (!snapshot) throw new Error('Missing real launch policy snapshot')
      db.prepare('UPDATE execution_policy_snapshots SET snapshot_json = ? WHERE run_id = ?').run(
        JSON.stringify({
          ...snapshot,
          profile: 'restricted',
          enforcement: 'enforced',
          requested: { ...snapshot.requested, write_roots: [] },
          actual: { ...snapshot.actual, write_roots: [], git_operations: ['read'] },
        }),
        run.runId
      )
    } finally {
      db.close()
    }
    const submitted = await cli(args)
    expect(submitted.code, submitted.stderr).toBe(0)
    const record = JSON.parse(submitted.stdout)
    expect(record).toMatchObject({
      reviewer_id: reviewer.id,
      reviewer_run_id: run.runId,
      conclusion: 'approve',
      accepted_at: null,
    })
    expect(record.reviewer_policy_id).toEqual(expect.any(String))
    expect((await f.context()).accepted).toBe(false)
    const headers = {
      'content-type': 'application/json',
      'x-hive-agent-token': token,
      'x-hive-agent-id': reviewer.id,
    }
    expect(
      (await f.request(`/${record.id}/accept`, { version: context.version }, headers)).status
    ).toBe(403)
    const publish = await fetch(
      `${f.server.baseUrl}/api/ui/workspaces/${f.workspace.id}/dispatches/${f.dispatch.id}/integration`,
      { method: 'POST', headers, body: JSON.stringify({}) }
    )
    expect(publish.status).toBe(403)
    expect((await f.request(`/${record.id}/accept`, { version: context.version })).status).toBe(200)
    f.server.store.stopAgentRun(run.runId)
    expect((await cli(args)).code).toBe(1)
  })
})
