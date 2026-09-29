import { afterEach, expect, test } from 'vitest'
import {
  startAuthorizedTestServer as startTestServer,
  type TestServerContext,
} from '../helpers/test-server.js'

let server: TestServerContext | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

const waitFor = async (assertion: () => void, timeout = 10_000) => {
  const deadline = Date.now() + timeout
  let failure: unknown
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch (error) {
      failure = error
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw failure
}

test('Dream delivery survives an Orchestrator restart and explicitly failed attempts can retry', async () => {
  server = await startTestServer()
  const store = server.store
  const workspace = store.createWorkspace(server.dataDir, 'Dream recovery')
  const actor = `${workspace.id}:orchestrator`
  const port = new URL(server.baseUrl).port
  store.configureAgentLaunch(workspace.id, actor, {
    command: process.execPath,
    args: [
      '-e',
      "process.stdin.on('data', chunk => process.stdout.write(chunk)); console.log('READY')",
    ],
  })
  const firstRun = await store.startAgent(workspace.id, actor, { hivePort: port })
  store.recordUserInput(
    workspace.id,
    actor,
    'Use the stable release channel for production deployments.'
  )
  const generated = await store.requestMemoryDreamGeneration(workspace.id)
  if (!generated?.generation?.attempt_id) throw new Error('Expected a generation attempt')
  const firstAttempt = generated.generation.attempt_id
  store.memory.create(workspace.id, { kind: 'decision', body: 'Use the release checklist.' })
  const consolidation = await store.requestMemoryDream(workspace.id)
  expect(consolidation.orchestratorRunId).toBe(firstRun.runId)
  await waitFor(() => {
    expect(store.getLiveRun(firstRun.runId).output.replace(/\s/g, '')).toContain('teamdreaminput')
  })
  store.stopAgentRun(firstRun.runId)
  await waitFor(() => expect(store.getActiveRunByAgentId(workspace.id, actor)).toBeUndefined())
  await waitFor(() => expect(store.resources.getSnapshot(workspace.id).reservations).toEqual([]))
  const secondRun = await store.startAgent(workspace.id, actor, { hivePort: port })
  await waitFor(() => {
    expect(store.memoryDream.get(workspace.id, generated.id)?.generation).toMatchObject({
      status: 'requested',
      run_id: secondRun.runId,
    })
    expect(store.memoryDream.get(workspace.id, consolidation.id)?.orchestratorRunId).toBe(
      secondRun.runId
    )
  })
  const resumed = store.memoryDream.get(workspace.id, generated.id)
  if (!resumed?.generation?.attempt_id) throw new Error('Expected a resumed attempt')
  expect(resumed.generation.attempt_id).not.toBe(firstAttempt)
  expect(resumed.generation.input_hash).toBe(generated.generation.input_hash)
  const request = (action: string, body: object) =>
    fetch(`${server?.baseUrl}/api/team/dream/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspace.id,
        from_agent_id: actor,
        token: store.peekAgentToken(actor),
        dream_id: generated.id,
        ...body,
      }),
    })
  const stale = await request('result', {
    attempt_id: firstAttempt,
    input_hash: generated.generation.input_hash,
    result: { candidates: [], summary: 'No reusable facts.' },
  })
  expect(stale.status).toBe(409)
  const failed = await request('fail', {
    attempt_id: resumed.generation.attempt_id,
    error: 'The evidence conflicts; review is needed.',
  })
  expect(failed.status).toBe(200)
  expect(store.memoryDream.get(workspace.id, generated.id)?.generation).toMatchObject({
    status: 'failed',
    error: 'The evidence conflicts; review is needed.',
  })
  const retried = await store.requestMemoryDreamGeneration(workspace.id, true)
  expect(retried?.id).toBe(generated.id)
  expect(retried?.generation?.attempt_id).not.toBe(resumed.generation.attempt_id)
  expect(retried?.generation?.input_hash).toBe(generated.generation.input_hash)
}, 30_000)

test('agent Dream input preserves complete paged records and rejects cross-workspace access', async () => {
  server = await startTestServer()
  const store = server.store
  const workspace = store.createWorkspace(server.dataDir, 'Dream input')
  const actor = `${workspace.id}:orchestrator`
  store.configureAgentLaunch(workspace.id, actor, {
    command: process.execPath,
    args: ['-e', 'process.stdin.resume()'],
  })
  await store.startAgent(workspace.id, actor, { hivePort: new URL(server.baseUrl).port })
  const expectedBodies = Array.from(
    { length: 6 },
    (_, index) => `${index}: ${'long evidence '.repeat(240)} end-${index}`
  )
  for (const body of expectedBodies) store.memory.create(workspace.id, { kind: 'fact', body })
  const draft = store.memoryDream.create(workspace.id)
  const input = (body: object) =>
    fetch(`${server?.baseUrl}/api/team/dream/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspace.id,
        from_agent_id: actor,
        token: store.peekAgentToken(actor),
        dream_id: draft.id,
        section: 'sources',
        ...body,
      }),
    })
  const bodies: string[] = []
  let offset: number | null = 0
  do {
    const response = await input({ offset, limit: 2 })
    expect(response.status).toBe(200)
    const page = (await response.json()) as {
      items: Array<{ body: string }>
      next_offset: number | null
    }
    bodies.push(...page.items.map((item) => item.body))
    offset = page.next_offset
  } while (offset !== null)
  expect(bodies.sort()).toEqual(expectedBodies.sort())
  expect((await input({ limit: 11 })).status).toBe(400)
  const other = store.createWorkspace(server.dataDir, 'Other Dream')
  expect((await input({ project_id: other.id })).status).toBe(401)
})

test('malformed agent Dream requests return 400 without consuming the frozen evidence', async () => {
  server = await startTestServer()
  const store = server.store
  const workspace = store.createWorkspace(server.dataDir, 'Dream request validation')
  const actor = `${workspace.id}:orchestrator`
  store.configureAgentLaunch(workspace.id, actor, {
    command: process.execPath,
    args: ['-e', 'process.stdin.resume()'],
  })
  await store.startAgent(workspace.id, actor, { hivePort: new URL(server.baseUrl).port })
  store.recordUserInput(workspace.id, actor, 'Retain release logs for seven days.')
  const draft = await store.requestMemoryDreamGeneration(workspace.id)
  if (!draft?.generation?.attempt_id) throw new Error('Expected a generation attempt')
  const identity = {
    project_id: workspace.id,
    from_agent_id: actor,
    token: store.peekAgentToken(actor),
    dream_id: draft.id,
    attempt_id: draft.generation.attempt_id,
    input_hash: draft.generation.input_hash,
  }
  const post = (action: string, raw: string) =>
    fetch(`${server?.baseUrl}/api/team/dream/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw,
    })
  for (const action of ['input', 'result', 'fail']) {
    for (const raw of ['null', '[]', '"text"', '{', '{"offset":NaN}']) {
      const response = await post(action, raw)
      expect(response.status, `${action}: ${raw}`).toBe(400)
      expect(await response.json()).toEqual({ error: expect.any(String) })
    }
  }
  for (const input of [
    { offset: null },
    { offset: 'NaN' },
    { offset: -1 },
    { offset: 0.5 },
    { limit: 0 },
    { limit: 11 },
    { limit: '1' },
  ]) {
    expect((await post('input', JSON.stringify({ ...identity, ...input }))).status).toBe(400)
  }
  const overflow = JSON.stringify({ ...identity, offset: 'OVERFLOW' }).replace(
    '"OVERFLOW"',
    '1e999'
  )
  expect((await post('input', overflow)).status).toBe(400)
  for (const result of [
    null,
    [],
    {},
    { candidates: null, summary: 'Invalid' },
    { candidates: [null], summary: 'Invalid' },
    { candidates: [], summary: '' },
  ]) {
    expect((await post('result', JSON.stringify({ ...identity, result }))).status).toBe(400)
  }
  expect(
    (
      await post(
        'result',
        JSON.stringify({
          ...identity,
          input_hash: 'not-a-hash',
          result: { candidates: [], summary: 'No facts.' },
        })
      )
    ).status
  ).toBe(400)
  for (const error of [null, [], {}, '', 1]) {
    expect((await post('fail', JSON.stringify({ ...identity, error }))).status).toBe(400)
  }
  expect(store.memoryDream.get(workspace.id, draft.id)?.generation).toMatchObject({
    status: 'requested',
    attempt_id: draft.generation.attempt_id,
  })
  expect(store.memoryDreamGeneration.cursor(workspace.id)).toMatchObject({ sequence: 0, offset: 0 })
  expect(store.memory.list(workspace.id)).toEqual([])
})

test('ordinary status stays accepted during mixed Dream and business work without feeding generation', async () => {
  server = await startTestServer()
  const store = server.store
  const workspace = store.createWorkspace(server.dataDir, 'Mixed status purpose')
  const actor = `${workspace.id}:orchestrator`
  const worker = store.addWorker(workspace.id, { name: 'Mixed worker', role: 'coder' })
  const port = new URL(server.baseUrl).port
  for (const agentId of [actor, worker.id])
    store.configureAgentLaunch(workspace.id, agentId, {
      command: process.execPath,
      args: ['-e', 'process.stdin.resume()'],
    })
  await store.startAgent(workspace.id, actor, { hivePort: port })
  store.memory.create(workspace.id, {
    body: 'Keep deployment decisions reviewed.',
    kind: 'decision',
  })
  const draft = store.memoryDream.create(workspace.id)
  const review = await store.requestMemoryDreamWorkerReview(workspace.id, draft.id, worker.id, port)
  const business = await store.dispatchTask(
    workspace.id,
    worker.id,
    'Verify production API port configuration.',
    { hivePort: port }
  )
  const before = store.getWorker(workspace.id, worker.id)
  const expectedState = { status: before.status, pendingTaskCount: before.pendingTaskCount }
  expect(expectedState).toEqual({ status: 'working', pendingTaskCount: 2 })
  const status = (body: object) =>
    fetch(`${server?.baseUrl}/api/team/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspace.id,
        from_agent_id: worker.id,
        token: store.peekAgentToken(worker.id),
        ...body,
      }),
    })
  const ambiguous = await status({
    result: 'Still checking the memory review and deployment task.',
  })
  expect(ambiguous.status).toBe(202)
  expect(await ambiguous.json()).toMatchObject({ ok: true, dispatch_id: null })
  const explicit = await status({
    dispatch_id: business.id,
    result: 'Confirmed production API port 4310.',
  })
  expect(explicit.status).toBe(202)
  expect(
    (await status({ progress_state: 'progress', result: 'Structured progress needs a dispatch.' }))
      .status
  ).toBe(400)
  expect(store.getWorker(workspace.id, worker.id)).toMatchObject(expectedState)
  for (const dispatchId of [review.dispatchId, business.id])
    expect(store.getDispatch(workspace.id, dispatchId)).toMatchObject({
      status: expect.stringMatching(/^(queued|submitted)$/),
      reportedAt: null,
      reportText: null,
    })
  store.memoryDream.discard(workspace.id, draft.id, draft.planRevision)
  const generated = await store.requestMemoryDreamGeneration(workspace.id)
  const statuses = generated?.generation?.input.messages
    .filter((message) => message.type === 'status')
    .map((message) => message.text)
  expect(statuses).toEqual(['Confirmed production API port 4310.'])
  expect(
    store
      .listMessagesForRecovery(workspace.id, 0)
      .filter((message) => message.type === 'status')
      .map((message) => message.text)
  ).toContain('Still checking the memory review and deployment task.')
}, 30_000)
