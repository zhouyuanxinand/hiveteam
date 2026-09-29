// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import type { CreateWorkspaceResponse } from '../../web/src/api.js'
import { I18nProvider } from '../../web/src/i18n.js'
import { executionCapabilityMessage } from '../../web/src/security/execution-policy-labels.js'
import { useTerminalRuns } from '../../web/src/terminal/useTerminalRuns.js'
import { UI_LANGUAGE_STORAGE_KEY } from '../../web/src/uiLanguage.js'
import { useWorkspaceCreate } from '../../web/src/useWorkspaceCreate.js'
import { OrchestratorPane } from '../../web/src/worker/OrchestratorPane.js'
import { useOrchestratorPaneState } from '../../web/src/worker/useOrchestratorPaneState.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const nativeFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.localStorage.removeItem(UI_LANGUAGE_STORAGE_KEY)
})

const Harness = ({
  workspaceId: initialWorkspaceId = '',
  createPath,
}: {
  workspaceId?: string
  createPath?: string
}) => {
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId)
  const creation = useWorkspaceCreate({
    onWorkspaceCreated: (workspace) => setWorkspaceId(workspace.id),
  })
  const terminalRuns = useTerminalRuns(workspaceId || null)
  const orchestrator = useOrchestratorPaneState({
    workspaceId,
    terminalRuns,
    autostartError: creation.orchestratorAutostartErrors[workspaceId] ?? null,
    onClearAutostartError: () =>
      creation.recordOrchestratorResult(workspaceId, { ok: true, error: null, run_id: null }),
    onAfterStart: (result) => creation.recordOrchestratorResult(workspaceId, result),
  })
  if (!workspaceId && createPath)
    return (
      <button
        type="button"
        onClick={() =>
          void creation.createNewWorkspace({
            name: 'Creation recovery fixture',
            path: createPath,
            initializationMode: 'basic',
            autostartOrchestrator: true,
            commandPresetId: null,
            startupCommand: `"${process.execPath}" -e "process.stdin.resume()"`,
          })
        }
      >
        Create fixture workspace
      </button>
    )
  return (
    <OrchestratorPane
      workspaceId={workspaceId}
      state={orchestrator.state}
      onStart={orchestrator.start}
      onRestart={orchestrator.restart}
      onStop={orchestrator.stop}
      onRemoveWorkspace={() => {}}
    />
  )
}

test('a real policy-denied orchestrator launch presents missing capabilities and only launches the synthetic CLI after explicit local authorization', async () => {
  const server = await startTestServer()
  try {
    const workspace = server.store.createWorkspace(server.dataDir, 'Policy recovery fixture')
    const agentId = `${workspace.id}:orchestrator`
    server.store.configureAgentLaunch(workspace.id, agentId, {
      command: process.execPath,
      args: [
        '-e',
        'console.log("POLICY_RECOVERY_READY");process.stdin.resume();setInterval(() => {}, 1000)',
      ],
    })
    const policy = await server.store.executionPolicies.preview(workspace.id, agentId)
    expect(policy.enforcement).toBe('unsupported')
    expect(policy.missing_capabilities.length).toBeGreaterThan(0)
    const cookie = await getUiCookie(server.baseUrl)
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const headers = new Headers(init?.headers)
      headers.set('cookie', cookie)
      return nativeFetch(new URL(path, server.baseUrl), { ...init, headers })
    })
    render(<Harness workspaceId={workspace.id} />)
    fireEvent.click(screen.getByTestId('orchestrator-start'))
    const failure = await screen.findByTestId('orchestrator-failed-body')
    expect(within(failure).getByTestId('orchestrator-error-message')).toHaveTextContent(
      'This CLI cannot enforce the requested execution policy.'
    )
    expect(server.store.listAgentRuns(agentId)).toEqual([])
    for (const capability of policy.missing_capabilities) {
      expect(within(failure).getByText(executionCapabilityMessage(capability, false))).toBeVisible()
    }
    fireEvent.click(within(failure).getByRole('button', { name: 'Review execution permissions' }))
    const dialog = await screen.findByRole('dialog')
    const authorize = await within(dialog).findByRole('button', {
      name: 'Authorize and retry launch',
    })
    expect(authorize).toBeDisabled()
    expect(
      (await server.store.executionPolicies.preview(workspace.id, agentId)).unsafe_grant
    ).toBeNull()
    expect(server.store.listAgentRuns(agentId)).toEqual([])
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /I trust this CLI/ }))
    fireEvent.click(authorize)
    await waitFor(() => expect(server.store.listAgentRuns(agentId)).toHaveLength(1), {
      timeout: 8000,
    })
    const run = server.store.getActiveRunByAgentId(workspace.id, agentId)
    if (!run) throw new Error('Authorized synthetic process did not start')
    await waitFor(
      () => expect(server.store.getLiveRun(run.runId).output).toContain('POLICY_RECOVERY_READY'),
      { timeout: 8000 }
    )
    await waitFor(() =>
      expect(document.getElementById(`orch-pty-${run.runId}`)).toBeInTheDocument()
    )
    expect(screen.queryByTestId('orchestrator-failed-body')).toBeNull()
    expect(
      (await server.store.executionPolicies.preview(workspace.id, agentId)).active_policy
        ?.enforcement
    ).toBe('trusted_unsafe')
  } finally {
    cleanup()
    vi.unstubAllGlobals()
    await server.close()
  }
}, 30_000)

test('workspace autostart preserves structured policy failures through creation state and presents Chinese recovery guidance without starting a process', async () => {
  const server = await startTestServer()
  try {
    const cookie = await getUiCookie(server.baseUrl)
    let creationResponse: CreateWorkspaceResponse | null = null
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const headers = new Headers(init?.headers)
      headers.set('cookie', cookie)
      const response = await nativeFetch(new URL(path, server.baseUrl), { ...init, headers })
      if (path === '/api/workspaces' && init?.method === 'POST')
        creationResponse = await response.clone().json()
      return response
    })
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'zh')
    render(
      <I18nProvider>
        <Harness createPath={server.dataDir} />
      </I18nProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Create fixture workspace' }))
    const failure = await screen.findByTestId('orchestrator-failed-body', undefined, {
      timeout: 8000,
    })
    expect(creationResponse).toMatchObject({
      orchestrator_start: { ok: false, error_code: 'execution_policy_denied', run_id: null },
    })
    const workspace = server.store.listWorkspaces()[0]
    if (!workspace) throw new Error('Workspace creation failed')
    const agentId = `${workspace.id}:orchestrator`
    const policy = await server.store.executionPolicies.preview(workspace.id, agentId)
    expect(creationResponse).toMatchObject({
      orchestrator_start: { missing_capabilities: policy.missing_capabilities },
    })
    expect(within(failure).getByRole('alert')).toHaveTextContent(
      '当前环境无法满足受限执行要求，进程尚未启动。'
    )
    for (const capability of policy.missing_capabilities)
      expect(within(failure).getByText(executionCapabilityMessage(capability, true))).toBeVisible()
    fireEvent.click(within(failure).getByRole('button', { name: '查看执行权限' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByRole('button', { name: '授权并重试启动' })).toBeDisabled()
    expect(server.store.listAgentRuns(agentId)).toEqual([])
    expect(policy.unsafe_grant).toBeNull()
  } finally {
    cleanup()
    vi.unstubAllGlobals()
    await server.close()
  }
}, 30_000)
