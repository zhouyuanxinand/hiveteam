// @vitest-environment jsdom
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { startAgentRun } from '../../web/src/api.js'
import { ExecutionPolicyButton } from '../../web/src/security/ExecutionPolicyButton.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const nativeFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('local UI requires explicit unsafe acknowledgement and shows the unchanged live policy after revocation', async () => {
  const server = await startTestServer()
  try {
    const workspace = server.store.createWorkspace(server.dataDir, 'Policy fixture')
    const worker = server.store.addWorker(workspace.id, { name: 'Synthetic CLI', role: 'reviewer' })
    server.store.configureAgentLaunch(workspace.id, worker.id, {
      command: process.execPath,
      args: [
        '-e',
        "process.stdout.write('synthetic ready'); process.stdin.resume(); setInterval(() => {}, 1000)",
      ],
    })
    const cookie = await getUiCookie(server.baseUrl)
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const headers = new Headers(init?.headers)
      headers.set('cookie', cookie)
      return nativeFetch(new URL(path, server.baseUrl), { ...init, headers })
    })
    render(<ExecutionPolicyButton workspaceId={workspace.id} agentId={worker.id} />)
    fireEvent.click(screen.getByRole('button', { name: 'Execution permissions' }))
    const authorize = await screen.findByRole('button', {
      name: 'Authorize unsafe exception for this agent',
    })
    expect(authorize).toBeDisabled()
    expect(await server.store.executionPolicies.preview(workspace.id, worker.id)).toMatchObject({
      profile: 'restricted',
      enforcement: 'unsupported',
      unsafe_grant: null,
    })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(authorize)
    await screen.findByRole('button', { name: 'Revoke exception and restore restricted defaults' })
    expect(await server.store.executionPolicies.preview(workspace.id, worker.id)).toMatchObject({
      profile: 'trusted_unsafe',
      enforcement: 'trusted_unsafe',
    })
    const run = await server.store.startAgent(workspace.id, worker.id, {
      hivePort: new URL(server.baseUrl).port,
    })
    cleanup()
    render(<ExecutionPolicyButton workspaceId={workspace.id} agentId={worker.id} running />)
    fireEvent.click(screen.getByRole('button', { name: 'Execution permissions' }))
    await screen.findByText('Current process: unsafe exception')
    fireEvent.click(
      screen.getByRole('button', { name: 'Revoke exception and restore restricted defaults' })
    )
    await screen.findByText('Next launch: unsupported, start will be rejected')
    expect(screen.getByText('Current process: unsafe exception')).toBeVisible()
    await waitFor(async () =>
      expect(
        (await server.store.executionPolicies.preview(workspace.id, worker.id)).unsafe_grant
      ).toBeNull()
    )
    expect(server.store.getLiveRun(run.runId).status).not.toBe('exited')
    server.store.stopAgentRun(run.runId)
    await waitFor(() => expect(server.store.getLiveRun(run.runId).status).toBe('exited'))
    await waitFor(() => expect(server.store.resources.getSnapshot().occupancy.global).toBe(0))
    await expect(
      server.store.startAgent(workspace.id, worker.id, { hivePort: new URL(server.baseUrl).port })
    ).rejects.toMatchObject({ code: 'execution_policy_denied' })
    expect(server.store.getWorker(workspace.id, worker.id).status).toBe('stopped')
    expect(server.store.peekAgentToken(worker.id)).toBeUndefined()
  } finally {
    cleanup()
    vi.unstubAllGlobals()
    await server.close()
  }
}, 30_000)

const RetryPolicyButton = ({ workspaceId, agentId }: { workspaceId: string; agentId: string }) => {
  const [launch, setLaunch] = useState('Not started')
  return (
    <>
      <ExecutionPolicyButton
        workspaceId={workspaceId}
        agentId={agentId}
        triggerLabel="Review execution permissions"
        onAuthorized={() => {
          void startAgentRun(workspaceId, agentId).then(
            ({ runId }) => setLaunch(`Started ${runId}`),
            (error: unknown) => setLaunch(error instanceof Error ? error.message : String(error))
          )
        }}
      />
      <p data-testid="launch-result">{launch}</p>
    </>
  )
}

const responseBarrier = () => {
  let receive = () => {}
  let resume = () => {}
  const received = new Promise<void>((resolve) => {
    receive = resolve
  })
  const pending = new Promise<void>((resolve) => {
    resume = resolve
  })
  return {
    receive,
    received,
    pending,
    release: async () => {
      resume()
      await setImmediate()
    },
  }
}

const withPolicyFixture = async (
  run: (fixture: {
    server: Awaited<ReturnType<typeof startTestServer>>
    workspaceId: string
    agentId: string
    configure: (message: string) => void
    responses: { method: string; path: string; status: number }[]
    requests: { method: string; path: string }[]
    holdAuthorization: () => ReturnType<typeof responseBarrier>
  }) => Promise<void>
) => {
  const server = await startTestServer()
  const barriers: ReturnType<typeof responseBarrier>[] = []
  try {
    const workspace = server.store.createWorkspace(server.dataDir, 'Retry policy fixture')
    const worker = server.store.addWorker(workspace.id, { name: 'Synthetic CLI', role: 'reviewer' })
    const configure = (message: string) => {
      server.store.configureAgentLaunch(workspace.id, worker.id, {
        command: process.execPath,
        args: [
          '-e',
          `process.stdout.write(${JSON.stringify(message)}); process.stdin.resume(); setInterval(() => {}, 1000)`,
        ],
      })
    }
    configure('synthetic initial configuration ready')
    const cookie = await getUiCookie(server.baseUrl)
    const responses: { method: string; path: string; status: number }[] = []
    const requests: { method: string; path: string }[] = []
    let pendingAuthorization: ReturnType<typeof responseBarrier> | undefined
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const headers = new Headers(init?.headers)
      headers.set('cookie', cookie)
      requests.push({ method: init?.method ?? 'GET', path })
      const response = await nativeFetch(new URL(path, server.baseUrl), { ...init, headers })
      responses.push({ method: init?.method ?? 'GET', path, status: response.status })
      if (init?.method === 'PUT' && pendingAuthorization) {
        const barrier = pendingAuthorization
        pendingAuthorization = undefined
        await response.clone().arrayBuffer()
        barrier.receive()
        await barrier.pending
      }
      return response
    })
    await run({
      server,
      workspaceId: workspace.id,
      agentId: worker.id,
      configure,
      responses,
      requests,
      holdAuthorization: () => {
        const barrier = responseBarrier()
        barriers.push(barrier)
        pendingAuthorization = barrier
        return barrier
      },
    })
  } finally {
    cleanup()
    await Promise.all(barriers.map((barrier) => barrier.release()))
    vi.unstubAllGlobals()
    await server.close()
  }
}

test('a CLI configuration change after preview rejects authorization and keeps the error without launching', async () => {
  await withPolicyFixture(async ({ server, workspaceId, agentId, configure, responses }) => {
    render(<RetryPolicyButton workspaceId={workspaceId} agentId={agentId} />)
    fireEvent.click(screen.getByRole('button', { name: 'Review execution permissions' }))
    const authorize = await screen.findByRole('button', { name: 'Authorize and retry launch' })
    expect(authorize).toBeDisabled()
    const previous = await server.store.executionPolicies.preview(workspaceId, agentId)
    configure('synthetic changed configuration ready')
    expect(
      (await server.store.executionPolicies.preview(workspaceId, agentId)).cli_fingerprint
    ).not.toBe(previous.cli_fingerprint)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(authorize)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'CLI or policy changed. Refresh the execution policy and review it again.'
    )
    expect(screen.getByRole('dialog')).toBeVisible()
    expect(screen.getByTestId('launch-result')).toHaveTextContent('Not started')
    expect(responses.filter((response) => response.method === 'PUT')).toMatchObject([
      { status: 409 },
    ])
    expect(responses.filter((response) => response.method === 'POST')).toEqual([])
    expect(await server.store.executionPolicies.preview(workspaceId, agentId)).toMatchObject({
      profile: 'restricted',
      enforcement: 'unsupported',
      unsafe_grant: null,
    })
    expect(server.store.listAgentRuns(agentId)).toEqual([])
    expect(server.store.peekAgentToken(agentId)).toBeUndefined()
    expect(server.store.resources.getSnapshot().occupancy.global).toBe(0)
  })
}, 30_000)

test.each([
  false,
  true,
])('a delayed authorization cannot affect another workspace after navigation (close first: %s)', async (closeFirst) => {
  await withPolicyFixture(async ({ server, workspaceId, agentId, requests, holdAuthorization }) => {
    const nextPath = join(server.dataDir, 'workspace-b')
    mkdirSync(nextPath)
    const nextWorkspace = server.store.createWorkspace(nextPath, 'Second workspace')
    const nextWorker = server.store.addWorker(nextWorkspace.id, {
      name: 'Second synthetic CLI',
      role: 'reviewer',
    })
    server.store.configureAgentLaunch(nextWorkspace.id, nextWorker.id, {
      command: process.execPath,
      args: ['-e', 'throw new Error("The second workspace must not launch")'],
    })
    const view = render(<RetryPolicyButton workspaceId={workspaceId} agentId={agentId} />)
    fireEvent.click(screen.getByRole('button', { name: 'Review execution permissions' }))
    await screen.findByRole('button', { name: 'Authorize and retry launch' })
    fireEvent.click(screen.getByRole('checkbox'))
    const delayed = holdAuthorization()
    fireEvent.click(screen.getByRole('button', { name: 'Authorize and retry launch' }))
    await delayed.received
    expect((await server.store.executionPolicies.preview(workspaceId, agentId)).enforcement).toBe(
      'trusted_unsafe'
    )
    if (closeFirst) fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    view.rerender(<RetryPolicyButton workspaceId={nextWorkspace.id} agentId={nextWorker.id} />)
    if (closeFirst)
      fireEvent.click(screen.getByRole('button', { name: 'Review execution permissions' }))
    await screen.findByText('Next launch: unsupported, start will be rejected')
    await act(async () => delayed.release())
    expect(screen.getByRole('dialog')).toBeVisible()
    expect(screen.getByText('Next launch: unsupported, start will be rejected')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Retry with authorized permissions' })).toBeNull()
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('button', { name: 'Authorize and retry launch' })).toBeEnabled()
    expect(screen.getByTestId('launch-result')).toHaveTextContent('Not started')
    expect(requests.filter((request) => request.method === 'POST')).toEqual([])
    expect(server.store.listAgentRuns(agentId)).toEqual([])
    expect(server.store.listAgentRuns(nextWorker.id)).toEqual([])
    expect(
      (await server.store.executionPolicies.preview(nextWorkspace.id, nextWorker.id)).unsafe_grant
    ).toBeNull()
    expect((await server.store.executionPolicies.preview(workspaceId, agentId)).enforcement).toBe(
      'trusted_unsafe'
    )
  })
}, 30_000)

test('closing the dialog during authorization preserves the grant without starting a process', async () => {
  await withPolicyFixture(async ({ server, workspaceId, agentId, requests, holdAuthorization }) => {
    render(<RetryPolicyButton workspaceId={workspaceId} agentId={agentId} />)
    fireEvent.click(screen.getByRole('button', { name: 'Review execution permissions' }))
    await screen.findByRole('button', { name: 'Authorize and retry launch' })
    fireEvent.click(screen.getByRole('checkbox'))
    const delayed = holdAuthorization()
    fireEvent.click(screen.getByRole('button', { name: 'Authorize and retry launch' }))
    await delayed.received
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await act(async () => delayed.release())
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(requests.filter((request) => request.method === 'POST')).toEqual([])
    expect(server.store.listAgentRuns(agentId)).toEqual([])
    expect((await server.store.executionPolicies.preview(workspaceId, agentId)).enforcement).toBe(
      'trusted_unsafe'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Review execution permissions' }))
    expect(
      await screen.findByRole('button', { name: 'Retry with authorized permissions' })
    ).toBeEnabled()
  })
}, 30_000)

test('reopening a valid authorization can retry the real launch without issuing another grant', async () => {
  await withPolicyFixture(async ({ server, workspaceId, agentId, responses }) => {
    render(<ExecutionPolicyButton workspaceId={workspaceId} agentId={agentId} />)
    fireEvent.click(screen.getByRole('button', { name: 'Execution permissions' }))
    await screen.findByRole('button', { name: 'Authorize unsafe exception for this agent' })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(
      screen.getByRole('button', { name: 'Authorize unsafe exception for this agent' })
    )
    await screen.findByRole('button', { name: 'Revoke exception and restore restricted defaults' })
    const authorized = await server.store.executionPolicies.preview(workspaceId, agentId)
    expect(authorized.enforcement).toBe('trusted_unsafe')
    expect(server.store.listAgentRuns(agentId)).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    cleanup()

    render(<RetryPolicyButton workspaceId={workspaceId} agentId={agentId} />)
    fireEvent.click(screen.getByRole('button', { name: 'Review execution permissions' }))
    fireEvent.click(
      await screen.findByRole('button', { name: 'Retry with authorized permissions' })
    )
    await waitFor(() => expect(screen.getByTestId('launch-result')).toHaveTextContent(/^Started /))
    expect(screen.queryByRole('dialog')).toBeNull()
    const runs = server.store.listAgentRuns(agentId)
    expect(runs).toHaveLength(1)
    const [run] = runs
    if (!run) throw new Error('Expected an authorized run to be persisted')
    await waitFor(
      () =>
        expect(server.store.getLiveRun(run.runId).output).toContain(
          'synthetic initial configuration ready'
        ),
      { timeout: 6000 }
    )
    expect(responses.filter((response) => response.method === 'PUT')).toHaveLength(1)
    expect(responses.filter((response) => response.method === 'POST')).toMatchObject([
      { status: 201 },
    ])
    expect(
      (await server.store.executionPolicies.preview(workspaceId, agentId)).unsafe_grant
    ).toEqual(authorized.unsafe_grant)
  })
}, 30_000)

test('reopening a stale authorization requires new acknowledgement before launching the changed CLI', async () => {
  await withPolicyFixture(async ({ server, workspaceId, agentId, configure, responses }) => {
    render(<ExecutionPolicyButton workspaceId={workspaceId} agentId={agentId} />)
    fireEvent.click(screen.getByRole('button', { name: 'Execution permissions' }))
    await screen.findByRole('button', { name: 'Authorize unsafe exception for this agent' })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(
      screen.getByRole('button', { name: 'Authorize unsafe exception for this agent' })
    )
    await screen.findByRole('button', { name: 'Revoke exception and restore restricted defaults' })
    const authorized = await server.store.executionPolicies.preview(workspaceId, agentId)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    cleanup()
    configure('synthetic reauthorized configuration ready')

    render(<RetryPolicyButton workspaceId={workspaceId} agentId={agentId} />)
    fireEvent.click(screen.getByRole('button', { name: 'Review execution permissions' }))
    const authorize = await screen.findByRole('button', { name: 'Authorize and retry launch' })
    expect(authorize).toBeDisabled()
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(screen.queryByRole('button', { name: 'Retry with authorized permissions' })).toBeNull()
    expect(server.store.listAgentRuns(agentId)).toEqual([])
    expect(responses.filter((response) => response.method === 'POST')).toEqual([])
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(authorize)
    await waitFor(() => expect(screen.getByTestId('launch-result')).toHaveTextContent(/^Started /))
    expect(screen.queryByRole('dialog')).toBeNull()
    const runs = server.store.listAgentRuns(agentId)
    expect(runs).toHaveLength(1)
    const [run] = runs
    if (!run) throw new Error('Expected the reauthorized run to be persisted')
    await waitFor(
      () =>
        expect(server.store.getLiveRun(run.runId).output).toContain(
          'synthetic reauthorized configuration ready'
        ),
      { timeout: 6000 }
    )
    const current = await server.store.executionPolicies.preview(workspaceId, agentId)
    expect(current.enforcement).toBe('trusted_unsafe')
    expect(current.unsafe_grant?.cli_fingerprint).not.toBe(authorized.unsafe_grant?.cli_fingerprint)
    expect(current.active_policy?.enforcement).toBe('trusted_unsafe')
  })
}, 30_000)
