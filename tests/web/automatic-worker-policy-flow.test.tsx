// @vitest-environment jsdom
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import type { TeamListItem } from '../../src/shared/types.js'
import { startAgentRun } from '../../web/src/api.js'
import { ExecutionPolicyButton } from '../../web/src/security/ExecutionPolicyButton.js'
import { WorkerModal } from '../../web/src/worker/WorkerModal.js'
import { authorizeSyntheticAgent } from '../helpers/authorized-runtime.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const nativeFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const withBlockedInterview = async (
  run: (fixture: {
    server: Awaited<ReturnType<typeof startTestServer>>
    workspaceId: string
    actorId: string
    worker: TeamListItem
    dispatchId: string
  }) => Promise<void>
) => {
  const server = await startTestServer()
  try {
    const workspace = server.store.createWorkspace(server.dataDir, 'Interview policy UI')
    const actorId = `${workspace.id}:orchestrator`
    const script = join(server.dataDir, 'member.mjs')
    writeFileSync(
      script,
      `import {appendFileSync} from 'node:fs';
const file=${JSON.stringify(server.dataDir)}+'/'+process.env.HIVE_AGENT_ID.replaceAll(':','_')+'.txt';
if(process.stdin.isTTY)process.stdin.setRawMode(true);
process.stdin.on('data',data=>appendFileSync(file,data));
console.log('MEMBER_READY');setInterval(()=>{},1000);`
    )
    const preset = server.store.settings.createCommandPreset({
      command: process.execPath,
      args: [script],
      displayName: 'Interview UI fixture',
      env: {},
      resumeArgsTemplate: null,
      sessionIdCapture: null,
      yoloArgsTemplate: null,
    })
    server.store.configureAgentLaunch(workspace.id, actorId, {
      command: process.execPath,
      args: [script],
      commandPresetId: preset.id,
    })
    await authorizeSyntheticAgent(server.store, workspace.id, actorId)
    await server.store.startAgent(workspace.id, actorId, {
      hivePort: new URL(server.baseUrl).port,
    })
    const pack = join(server.dataDir, 'pack')
    mkdirSync(join(pack, 'grilling'), { recursive: true })
    writeFileSync(
      join(pack, 'grilling/SKILL.md'),
      '---\nname: grilling\ndescription: Interview\n---\nPINNED-INTERVIEW'
    )
    const release = await server.store.skills.resolvePack({
      packName: 'fixture',
      source: { type: 'local', path: pack },
    })
    const plan = await server.store.skills.plan(workspace.id, {
      action: 'bind',
      packName: 'fixture',
      releaseId: release.id,
      profiles: { orchestrator: ['grilling'], custom: [] },
      nativeExposure: [],
    })
    await server.store.skills.applyPlan(workspace.id, plan.id)
    const response = await nativeFetch(`${server.baseUrl}/api/team/grill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspace.id,
        from_agent_id: actorId,
        token: server.store.peekAgentToken(actorId),
        request_id: randomUUID(),
        text: 'Clarify the retained task',
        skill_name: 'fixture/grilling',
      }),
    })
    const blocked = await response.json()
    expect(blocked).toMatchObject({ ok: false, status: 'failed' })
    const worker = server.store
      .listWorkers(workspace.id)
      .find((item) => item.id === blocked.worker_id)
    if (!worker) throw new Error('Expected the automatically created interview member')
    const cookie = await getUiCookie(server.baseUrl)
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const headers = new Headers(init?.headers)
      headers.set('cookie', cookie)
      return nativeFetch(new URL(path, server.baseUrl), { ...init, headers })
    })
    await run({
      server,
      workspaceId: workspace.id,
      actorId,
      worker,
      dispatchId: blocked.dispatch_id,
    })
  } finally {
    cleanup()
    vi.unstubAllGlobals()
    await server.close()
  }
}

const ResumableWorker = ({
  workspaceId,
  worker,
}: {
  workspaceId: string
  worker: TeamListItem
}) => {
  const [runId, setRunId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  return (
    <WorkerModal
      workspaceId={workspaceId}
      worker={worker}
      runId={runId}
      starting={false}
      startError={error}
      onClose={() => {}}
      onStart={() => {
        void startAgentRun(workspaceId, worker.id).then(
          (result) => setRunId(result.runId),
          (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))
        )
      }}
    />
  )
}

test('automatic interview trust is preselected but only the authorization action saves it and resumes the retained dispatch', async () => {
  await withBlockedInterview(async ({ server, workspaceId, worker, dispatchId }) => {
    render(<ResumableWorker workspaceId={workspaceId} worker={worker} />)
    fireEvent.click(screen.getByRole('button', { name: 'Execution permissions' }))
    expect(await screen.findByRole('checkbox', { name: /I trust this CLI/ })).toBeChecked()
    expect(
      screen.getByRole('checkbox', { name: /Trust future automatically created members/ })
    ).toBeChecked()
    expect(
      (await server.store.executionPolicies.preview(workspaceId, worker.id)).unsafe_grant
    ).toBeNull()
    expect(server.store.listAgentRuns(worker.id)).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Authorize and retry launch' }))
    await waitFor(
      () => expect(server.store.getDispatch(workspaceId, dispatchId)?.status).toBe('submitted'),
      { timeout: 15000 }
    )
    const run = server.store.getActiveRunByAgentId(workspaceId, worker.id)
    if (!run) throw new Error('Expected authorization to start the existing member')
    await waitFor(() => expect(document.getElementById(`worker-pty-${run.runId}`)).not.toBeNull())
    await expect
      .poll(() => readFileSync(join(server.dataDir, `${worker.id}.txt`), 'utf8'), {
        timeout: 10000,
      })
      .toContain('PINNED-INTERVIEW')
    expect(
      readFileSync(join(server.dataDir, `${worker.id}.txt`), 'utf8').split(
        'Clarify the retained task'
      )
    ).toHaveLength(2)
    expect(server.store.listWorkers(workspaceId)).toHaveLength(1)
    expect(await server.store.executionPolicies.preview(workspaceId, worker.id)).toMatchObject({
      enforcement: 'trusted_unsafe',
      trust_automatic_workers: true,
    })
  })
}, 45000)

test('saved automatic defaults survive member revocation and can change without granting or starting the member', async () => {
  await withBlockedInterview(async ({ server, workspaceId, actorId, worker }) => {
    render(<ExecutionPolicyButton workspaceId={workspaceId} agentId={worker.id} />)
    fireEvent.click(screen.getByRole('button', { name: 'Execution permissions' }))
    fireEvent.click(
      await screen.findByRole('button', { name: 'Authorize unsafe exception for this agent' })
    )
    await screen.findByRole('button', { name: 'Revoke exception and restore restricted defaults' })
    expect(await server.store.executionPolicies.preview(workspaceId, worker.id)).toMatchObject({
      enforcement: 'trusted_unsafe',
      trust_automatic_workers: true,
    })
    fireEvent.click(
      screen.getByRole('checkbox', { name: /Trust future automatically created members/ })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save automatic member default' }))
    await waitFor(async () =>
      expect(await server.store.executionPolicies.preview(workspaceId, worker.id)).toMatchObject({
        enforcement: 'trusted_unsafe',
        trust_automatic_workers: false,
      })
    )
    expect(screen.getByRole('button', { name: 'Save automatic member default' })).toBeDisabled()
    expect(server.store.listAgentRuns(worker.id)).toEqual([])
    const next = await server.store.workerLifecycle.createClarification(
      workspaceId,
      actorId,
      new URL(server.baseUrl).port,
      () => {}
    )
    expect(
      (await server.store.executionPolicies.preview(workspaceId, next.id)).unsafe_grant
    ).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByRole('button', { name: 'Execution permissions' }))
    expect(
      await screen.findByRole('checkbox', { name: /Trust future automatically created members/ })
    ).not.toBeChecked()
    expect(
      screen.getByRole('button', { name: 'Revoke exception and restore restricted defaults' })
    ).toBeEnabled()
    fireEvent.click(
      screen.getByRole('button', { name: 'Revoke exception and restore restricted defaults' })
    )
    await screen.findByRole('button', { name: 'Authorize unsafe exception for this agent' })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByRole('button', { name: 'Execution permissions' }))
    expect(
      await screen.findByRole('checkbox', {
        name: /Trust future automatically created members/,
      })
    ).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /I trust this CLI/ })).toBeChecked()
    fireEvent.click(
      screen.getByRole('button', { name: 'Authorize unsafe exception for this agent' })
    )
    await screen.findByRole('button', { name: 'Revoke exception and restore restricted defaults' })
    expect(await server.store.executionPolicies.preview(workspaceId, worker.id)).toMatchObject({
      enforcement: 'trusted_unsafe',
      trust_automatic_workers: false,
    })
    expect(server.store.listAgentRuns(worker.id)).toEqual([])
    fireEvent.click(
      screen.getByRole('checkbox', { name: /Trust future automatically created members/ })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save automatic member default' }))
    await waitFor(async () =>
      expect(
        (await server.store.executionPolicies.preview(workspaceId, worker.id))
          .trust_automatic_workers
      ).toBe(true)
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Revoke exception and restore restricted defaults' })
      ).toBeEnabled()
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Revoke exception and restore restricted defaults' })
    )
    await screen.findByRole('button', { name: 'Authorize unsafe exception for this agent' })
    for (const enabled of [false, true, false]) {
      fireEvent.click(
        screen.getByRole('checkbox', { name: /Trust future automatically created members/ })
      )
      fireEvent.click(screen.getByRole('button', { name: 'Save automatic member default' }))
      await waitFor(async () =>
        expect(await server.store.executionPolicies.preview(workspaceId, worker.id)).toMatchObject({
          profile: 'restricted',
          unsafe_grant: null,
          trust_automatic_workers: enabled,
        })
      )
      await waitFor(() =>
        expect(
          screen.getByRole('checkbox', { name: /Trust future automatically created members/ })
        ).toBeEnabled()
      )
    }
    expect(server.store.listAgentRuns(worker.id)).toEqual([])
  })
}, 45000)

test('the user can authorize only this automatic member by clearing the future-member default', async () => {
  await withBlockedInterview(async ({ server, workspaceId, worker }) => {
    render(<ExecutionPolicyButton workspaceId={workspaceId} agentId={worker.id} />)
    fireEvent.click(screen.getByRole('button', { name: 'Execution permissions' }))
    const acknowledgement = await screen.findByRole('checkbox', { name: /I trust this CLI/ })
    fireEvent.click(acknowledgement)
    expect(
      screen.getByRole('button', { name: 'Authorize unsafe exception for this agent' })
    ).toBeDisabled()
    expect(
      (await server.store.executionPolicies.preview(workspaceId, worker.id)).unsafe_grant
    ).toBeNull()
    fireEvent.click(acknowledgement)
    fireEvent.click(
      screen.getByRole('checkbox', { name: /Trust future automatically created members/ })
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Authorize unsafe exception for this agent' })
    )
    await screen.findByRole('button', { name: 'Revoke exception and restore restricted defaults' })
    expect(await server.store.executionPolicies.preview(workspaceId, worker.id)).toMatchObject({
      enforcement: 'trusted_unsafe',
      trust_automatic_workers: false,
    })
    expect(server.store.listAgentRuns(worker.id)).toEqual([])
  })
}, 45000)
