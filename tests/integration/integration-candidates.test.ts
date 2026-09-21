import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, test } from 'vitest'
import { runGit } from '../../src/server/git-command.js'
import { commitReviewFixture, createCodeReviewFixture } from '../helpers/code-review-fixture.js'

const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error('Missing expected test fixture value')
  return value
}

const fixtures: Awaited<ReturnType<typeof createCodeReviewFixture>>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close()
})
const until = async (check: () => void | Promise<void>) => {
  const end = Date.now() + 45000
  for (;;) {
    try {
      await check()
      return
    } catch (error) {
      if (Date.now() > end) throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}
const setup = async () => {
  const f = await createCodeReviewFixture()
  fixtures.push(f)
  const call = (dispatchId: string, suffix = '', body?: unknown) =>
    fetch(
      `${f.server.baseUrl}/api/ui/workspaces/${f.workspace.id}/dispatches/${dispatchId}/integration-candidates${suffix}`,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: { cookie: f.cookie, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }
    )
  const acceptSource = async (dispatchId: string) => {
    const source = await f.server.store.verifications.view(f.workspace.id, dispatchId)
    const run = await f.server.store.verifications.start(f.workspace.id, dispatchId, {
      headSha: required(source.headSha),
      reportRevision: source.reportRevision,
      command: 'node -e "console.log(\'source checked\')"',
    })
    await until(() => expect(f.server.store.verifications.get(run.id)?.state).toBe('passed'))
    await until(async () =>
      expect((await f.server.store.verifications.view(f.workspace.id, dispatchId)).canAccept).toBe(
        true
      )
    )
    await f.server.store.verifications.accept(f.workspace.id, dispatchId, run.id)
    const review = await f.server.store.codeReviews.view(f.workspace.id, dispatchId)
    const record = await f.server.store.codeReviews.submit(
      f.workspace.id,
      dispatchId,
      'local_user',
      {
        request_id: randomUUID(),
        version: required(review.version),
        conclusion: 'approve',
        summary: 'Reviewed source version',
      }
    )
    await f.server.store.codeReviews.accept(
      f.workspace.id,
      dispatchId,
      record.id,
      required(review.version)
    )
  }
  const prepare = async (dispatchId: string) => {
    const source = await f.server.store.codeReviews.view(f.workspace.id, dispatchId)
    const response = await call(dispatchId, '', { version: source.version })
    expect(response.status, await response.clone().text()).toBe(202)
    const candidate = (await response.json()) as { id: string }
    await until(() =>
      expect(f.server.store.candidates.list(f.workspace.id, dispatchId)[0]?.state).toMatch(
        /prepared|conflicted/u
      )
    )
    return f.server.store.candidates.view(f.workspace.id, dispatchId, candidate.id)
  }
  const qualify = async (dispatchId: string, id: string, sha: string) => {
    const profile = f.server.store.verifications.profiles.save(f.workspace.id, {
      name: 'Candidate check',
      command: 'node -e "console.log(\'combined checked\')"',
      execution: 'trusted_unsafe',
      network: 'unrestricted',
    })
    const start = await call(dispatchId, `/${id}/verify`, {
      candidate_sha: sha,
      profile_id: profile.id,
    })
    expect(start.status, await start.clone().text()).toBe(202)
    const verification = await start.json()
    await until(() =>
      expect(f.server.store.verifications.get(verification.id)?.state).toBe('passed')
    )
    expect(
      (
        await call(dispatchId, `/${id}/accept`, {
          candidate_sha: sha,
          verification_id: verification.id,
        })
      ).status
    ).toBe(409)
    expect(
      (
        await call(dispatchId, `/${id}/review`, {
          candidate_sha: sha,
          note: 'Reviewed the combined changes',
        })
      ).status
    ).toBe(200)
    expect(
      (
        await call(dispatchId, `/${id}/accept`, {
          candidate_sha: sha,
          verification_id: verification.id,
        })
      ).status
    ).toBe(200)
    return verification.id as string
  }
  return { f, call, acceptSource, prepare, qualify }
}

test('two workers from one baseline integrate sequentially; the second candidate verifies the combined SHA and survives restart', async () => {
  const { f, call, acceptSource, prepare, qualify } = await setup()
  const second = f.server.store.addWorker(f.workspace.id, { name: 'Second', role: 'coder' })
  await f.server.store.worktrees.create(f.workspace, second.id)
  const dispatch = await f.server.store.dispatchTask(
    f.workspace.id,
    second.id,
    'Add independent feature'
  )
  const path = f.server.store.getDispatchWorkspacePath(f.workspace.id, dispatch.id)
  await writeFile(join(path, 'feature.txt'), 'feature\n')
  const source = await commitReviewFixture(path, 'Second delivery')
  f.server.store.reportTask(f.workspace.id, second.id, {
    dispatchId: dispatch.id,
    outcome: 'success',
    text: 'Feature done',
  })
  await acceptSource(f.dispatch.id)
  await acceptSource(dispatch.id)
  const first = await f.server.store.integrations.view(f.workspace.id, f.dispatch.id)
  await f.server.store.integrations.integrate(f.workspace.id, f.dispatch.id, {
    sourceSha: required(first.sourceSha),
    targetSha: required(first.targetSha),
    verificationId: required(first.verificationId),
  })
  const preview = await prepare(dispatch.id),
    c = preview.candidate
  expect(c.target_sha).toBe(f.source)
  expect(c.source_sha).toBe(source)
  expect(c.candidate_sha).not.toBe(source)
  expect(await readFile(join(c.checkout_path, 'value.txt'), 'utf8')).toBe('delivered\n')
  expect(await readFile(join(c.checkout_path, 'feature.txt'), 'utf8')).toBe('feature\n')
  const verificationId = await qualify(dispatch.id, c.id, required(c.candidate_sha))
  expect(f.server.store.verifications.get(verificationId)?.headSha).toBe(c.candidate_sha)
  expect(
    (await f.server.store.verifications.view(f.workspace.id, dispatch.id)).runs[0]?.headSha
  ).toBe(source)
  await f.restart()
  expect(
    (await f.server.store.candidates.view(f.workspace.id, dispatch.id, c.id)).can_integrate
  ).toBe(true)
  const response = await call(dispatch.id, `/${c.id}/integrate`, {
    candidate_sha: c.candidate_sha,
    target_sha: c.target_sha,
    verification_id: verificationId,
  })
  expect(response.status, await response.clone().text()).toBe(200)
  expect((await runGit(f.project, ['rev-parse', 'HEAD'])).trim()).toBe(c.candidate_sha)
  expect(await readFile(join(f.project, 'feature.txt'), 'utf8')).toBe('feature\n')
  expect(
    (
      await call(dispatch.id, `/${c.id}/integrate`, {
        candidate_sha: c.candidate_sha,
        target_sha: c.target_sha,
        verification_id: verificationId,
      })
    ).status
  ).toBe(200)
}, 150000)

test('an interrupted SQLite completion preserves the installed Git SHA and reconciles after restart', async () => {
  const { f, call, acceptSource, prepare, qualify } = await setup()
  await acceptSource(f.dispatch.id)
  const { candidate: c } = await prepare(f.dispatch.id)
  if (!c.candidate_sha) throw new Error('Expected prepared candidate')
  const verificationId = await qualify(f.dispatch.id, c.id, c.candidate_sha)
  const body = {
    candidate_sha: c.candidate_sha,
    target_sha: c.target_sha,
    verification_id: verificationId,
  }
  const db = new Database(join(f.dataDir, 'runtime.sqlite'))
  try {
    db.exec(
      `CREATE TRIGGER fail_candidate_completion BEFORE UPDATE ON integration_candidates WHEN json_extract(NEW.snapshot,'$.state')='integrated' BEGIN SELECT RAISE(ABORT,'synthetic completion failure'); END`
    )
    expect((await call(f.dispatch.id, `/${c.id}/integrate`, body)).status).toBe(500)
    expect((await runGit(f.project, ['rev-parse', 'HEAD'])).trim()).toBe(c.candidate_sha)
    expect(f.server.store.candidates.list(f.workspace.id, f.dispatch.id)[0]?.state).toBe(
      'integrating'
    )
    db.exec('DROP TRIGGER fail_candidate_completion')
  } finally {
    db.close()
  }
  await f.restart()
  const run = await f.server.store.startAgent(f.workspace.id, f.worker.id, {
    hivePort: new URL(f.server.baseUrl).port,
  })
  await until(() =>
    expect(
      f.server.store.listAgentRuns(f.worker.id).find((item) => item.runId === run.runId)
    ).toMatchObject({ pid: expect.any(Number), endedAt: null })
  )
  expect(f.server.store.getActiveRunByAgentId(f.workspace.id, f.worker.id)?.runId).toBe(run.runId)
  expect((await call(f.dispatch.id, `/${c.id}/integrate`, body)).status).toBe(409)
  f.server.store.stopAgentRun(run.runId)
  await until(() =>
    expect(
      f.server.store.listAgentRuns(f.worker.id).find((item) => item.runId === run.runId)?.status
    ).toMatch(/exited|error/u)
  )
  const recovered = await call(f.dispatch.id, `/${c.id}/integrate`, body)
  expect(recovered.status, await recovered.clone().text()).toBe(200)
  const view = await recovered.json()
  expect(view.candidate.state).toBe('integrated')
  expect(
    view.history.some(
      (entry: { snapshot: { state: string } }) => entry.snapshot.state === 'integrating'
    )
  ).toBe(true)
  expect(await readFile(join(f.project, 'value.txt'), 'utf8')).toBe('delivered\n')
  expect((await runGit(f.project, ['status', '--porcelain'])).trim()).toBe('')
}, 150000)

test('cancelling a claimed candidate cannot release its budget while Git preparation is running', async () => {
  const { f, call, acceptSource } = await setup()
  await acceptSource(f.dispatch.id)
  const source = await f.server.store.codeReviews.view(f.workspace.id, f.dispatch.id)
  const response = await call(f.dispatch.id, '', { version: source.version })
  expect(response.status).toBe(202)
  const candidate = await response.json()
  const queued = () =>
    f.server.store.resourceQueue
      .list(f.workspace.id)
      .find((entry) => entry.execution_key === `candidate:${candidate.id}`)
  await until(() => expect(queued()?.status).toBe('starting'))
  const entry = required(queued())
  const cancelled = await fetch(`${f.server.baseUrl}/api/resources/queue/${entry.id}/cancel`, {
    method: 'POST',
    headers: { cookie: f.cookie },
  })
  expect(cancelled.status).toBe(409)
  expect(queued()?.status).toBe('starting')
  expect(f.server.store.resources.getSnapshot().occupancy.by_kind.verification).toBe(1)
  await until(() =>
    expect(f.server.store.candidates.list(f.workspace.id, f.dispatch.id)[0]?.state).toBe('prepared')
  )
  await until(() =>
    expect(f.server.store.resources.getSnapshot().occupancy.by_kind.verification).toBe(0)
  )
}, 90000)

test('target advancement rejects candidate acceptance and integration without losing its evidence or directory', async () => {
  const { f, call, acceptSource, prepare, qualify } = await setup()
  await acceptSource(f.dispatch.id)
  const { candidate: c } = await prepare(f.dispatch.id)
  const verificationId = await qualify(f.dispatch.id, c.id, required(c.candidate_sha))
  await writeFile(join(f.project, 'target.txt'), 'target progressed\n')
  const newTarget = await commitReviewFixture(f.project, 'Target moves')
  const body = {
    candidate_sha: c.candidate_sha,
    target_sha: c.target_sha,
    verification_id: verificationId,
  }
  expect((await call(f.dispatch.id, `/${c.id}/accept`, body)).status).toBe(409)
  expect((await call(f.dispatch.id, `/${c.id}/integrate`, body)).status).toBe(409)
  expect((await runGit(f.project, ['rev-parse', 'HEAD'])).trim()).toBe(newTarget)
  expect(f.server.store.verifications.get(verificationId)?.state).toBe('passed')
  expect(await readFile(join(c.checkout_path, 'value.txt'), 'utf8')).toBe('delivered\n')
  const next = await prepare(f.dispatch.id)
  expect(next.candidate.id).not.toBe(c.id)
  expect(next.candidate.target_sha).toBe(newTarget)
}, 150000)

test('conflicted candidates retain real Git state across restart and continue only after staged resolution', async () => {
  const { f, call, acceptSource, prepare } = await setup()
  await acceptSource(f.dispatch.id)
  await writeFile(join(f.project, 'value.txt'), 'target conflicting\n')
  await commitReviewFixture(f.project, 'Target conflicts')
  const preview = await prepare(f.dispatch.id),
    c = preview.candidate
  expect(c.state).toBe('conflicted')
  expect(preview.conflicts).toContain('value.txt')
  expect((await call(f.dispatch.id, `/${c.id}/continue`, {})).status).toBe(409)
  await f.restart()
  expect(
    (await f.server.store.candidates.view(f.workspace.id, f.dispatch.id, c.id)).conflicts
  ).toContain('value.txt')
  await writeFile(join(c.checkout_path, 'value.txt'), 'resolved together\n')
  await runGit(c.checkout_path, ['add', 'value.txt'])
  const response = await call(f.dispatch.id, `/${c.id}/continue`, {})
  expect(response.status, await response.clone().text()).toBe(200)
  const ready = await response.json()
  expect(ready.candidate.state).toBe('prepared')
  expect(ready.can_integrate).toBe(false)
  expect(await readFile(join(f.project, 'value.txt'), 'utf8')).toBe('target conflicting\n')
  expect((await call(f.dispatch.id, `/${c.id}/abandon`, {})).status).toBe(200)
  expect(await readFile(join(c.checkout_path, 'value.txt'), 'utf8')).toBe('resolved together\n')
}, 150000)
