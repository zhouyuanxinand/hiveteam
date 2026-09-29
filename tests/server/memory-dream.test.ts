import { afterEach, describe, expect, test } from 'vitest'
import type { MemoryDreamOperation } from '../../src/shared/memory-dream-plan.js'

import { startAuthorizedTestServer as startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []

const waitFor = async (assertion: () => void, timeoutMs = 4_000) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw lastError
}

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
})

describe('team memory Dream routes', () => {
  test('requires the Orchestrator to submit and can roll the consolidation back', async () => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const workspace = server.store.createWorkspace(server.dataDir, 'Dream')
    const memoryUrl = `${server.baseUrl}/api/ui/workspaces/${workspace.id}/memory`
    const dreamUrl = `${memoryUrl}/dream`

    const createMemory = await fetch(memoryUrl, {
      body: JSON.stringify({
        body: 'Keep the test server on port 4310.',
        kind: 'decision',
        scope: 'workspace',
        tags: ['tests'],
      }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })
    expect(createMemory.status).toBe(201)
    const source = (await createMemory.json()) as { id: string }

    const second = server.store.memory.create(workspace.id, {
      kind: 'decision',
      body: 'Keep integration tests isolated.',
    })
    const createDream = await fetch(dreamUrl, {
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })
    expect(createDream.status).toBe(201)
    const dream = (await createDream.json()) as {
      id: string
      status: string
      plan_revision: number
      operations: MemoryDreamOperation[]
    }
    expect(dream.status).toBe('review')
    expect(dream.operations[0]?.sources.map((ref) => ref.memory_id)).toEqual(
      expect.arrayContaining([source.id, second.id])
    )

    const worker = server.store.addWorker(workspace.id, {
      name: 'Reviewer',
      role: 'reviewer',
    })
    const unauthorizedSubmit = await fetch(`${dreamUrl}/${dream.id}/submit`, {
      body: JSON.stringify({ orchestrator_id: worker.id }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })
    expect(unauthorizedSubmit.status).toBe(403)

    const submitted = await fetch(`${dreamUrl}/${dream.id}/submit`, {
      body: JSON.stringify({
        orchestrator_id: `${workspace.id}:orchestrator`,
        expected_revision: dream.plan_revision,
      }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })
    expect(submitted.status).toBe(200)
    const submittedBody = (await submitted.json()) as {
      created_memory_ids: string[]
      status: string
    }
    expect(submittedBody.status).toBe('submitted')
    expect(submittedBody.created_memory_ids).toHaveLength(1)
    expect(server.store.memory.get(workspace.id, source.id)?.status).toBe('archived')

    const rollback = await fetch(`${dreamUrl}/${dream.id}/rollback`, {
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })
    expect(rollback.status).toBe(200)
    await expect(rollback.json()).resolves.toEqual(
      expect.objectContaining({ status: 'rolled_back' })
    )
    expect(server.store.memory.get(workspace.id, source.id)?.status).toBe('active')
    expect(
      server.store.memory.get(workspace.id, submittedBody.created_memory_ids[0] ?? '')
    ).toEqual(expect.objectContaining({ disabled: true, status: 'archived' }))
  })

  test('delivers Dream review to the Orchestrator and records worker feedback', async () => {
    const server = await startTestServer()
    servers.push(server)
    const workspace = server.store.createWorkspace(server.dataDir, 'Dream execution')
    const orchestrator = server.store
      .getWorkspaceSnapshot(workspace.id)
      .agents.find((agent) => agent.role === 'orchestrator')
    if (!orchestrator) throw new Error('Expected default Orchestrator')
    const worker = server.store.addWorker(workspace.id, { name: 'Reviewer', role: 'reviewer' })
    const launchConfig = { args: ['-e', 'process.stdin.resume()'], command: process.execPath }
    server.store.configureAgentLaunch(workspace.id, orchestrator.id, launchConfig)
    server.store.configureAgentLaunch(workspace.id, worker.id, launchConfig)
    await server.store.startAgent(workspace.id, orchestrator.id, { hivePort: '4010' })

    server.store.memory.create(workspace.id, {
      body: 'The release checklist must run before deployment.',
      kind: 'decision',
      scope: 'workspace',
    })
    const dream = await server.store.requestMemoryDream(workspace.id)
    await waitFor(() => {
      expect(server.store.memoryDream.get(workspace.id, dream.id)).toMatchObject({
        executionStatus: 'requested',
        orchestratorRunId: expect.any(String),
      })
    })

    const review = await server.store.requestMemoryDreamWorkerReview(
      workspace.id,
      dream.id,
      worker.id,
      '4010'
    )
    expect(review).toMatchObject({ status: 'queued', workerId: worker.id })

    const reported = server.store.reportTask(workspace.id, worker.id, {
      dispatchId: review.dispatchId,
      text: 'The checklist decision is clear and should remain in the consolidated memory.',
    })
    expect(reported.dispatch).toMatchObject({ id: review.dispatchId, status: 'reported' })
    expect(server.store.memoryDream.listReviews(workspace.id, dream.id)).toEqual([
      expect.objectContaining({
        dispatchId: review.dispatchId,
        reviewText: expect.stringContaining('checklist decision'),
        status: 'completed',
      }),
    ])
  })

  test('preserves structured procedure references through Dream review and submission', async () => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const workspace = server.store.createWorkspace(server.dataDir, 'Dream procedures')
    const memoryUrl = `${server.baseUrl}/api/ui/workspaces/${workspace.id}/memory`
    const dreamUrl = `${memoryUrl}/dream`

    const sourceResponse = await fetch(memoryUrl, {
      body: JSON.stringify({
        body: 'Use the release checklist for every production deployment.',
        kind: 'procedure_ref',
        procedure_ref: {
          id: '.hive/workflows/release-check.ts',
          title: 'Release checklist',
          type: 'workflow',
        },
        scope: 'workspace',
      }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })
    expect(sourceResponse.status).toBe(201)

    const dreamResponse = await fetch(dreamUrl, {
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })
    expect(dreamResponse.status).toBe(201)
    const dream = (await dreamResponse.json()) as {
      id: string
      plan_revision: number
      operations: MemoryDreamOperation[]
    }
    const operation = dream.operations[0]
    if (!operation) throw new Error('Expected a procedure rewrite')
    const suggestion = operation.result
    expect(suggestion).toMatchObject({
      kind: 'procedure_ref',
      procedure_ref: {
        id: '.hive/workflows/release-check.ts',
        title: 'Release checklist',
        type: 'workflow',
      },
    })

    const invalidUpdate = await fetch(`${dreamUrl}/${dream.id}`, {
      body: JSON.stringify({
        expected_revision: dream.plan_revision,
        operations: [{ ...operation, result: { ...suggestion, procedure_ref: null } }],
      }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'PATCH',
    })
    expect(invalidUpdate.status).toBe(400)

    const submitted = await fetch(`${dreamUrl}/${dream.id}/submit`, {
      body: JSON.stringify({
        orchestrator_id: `${workspace.id}:orchestrator`,
        expected_revision: dream.plan_revision,
      }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })
    expect(submitted.status).toBe(200)
    const submittedBody = (await submitted.json()) as { created_memory_ids: string[] }
    expect(submittedBody.created_memory_ids).toEqual([])
    const createdId = operation.sources[0]?.memory_id
    expect(createdId).toBeTruthy()
    expect(server.store.memory.get(workspace.id, createdId ?? '')).toMatchObject({
      kind: 'procedure_ref',
      procedureRef: {
        id: '.hive/workflows/release-check.ts',
        title: 'Release checklist',
        type: 'workflow',
      },
    })
  })
})
