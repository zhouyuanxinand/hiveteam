// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import type { TeamListItem } from '../../src/shared/types.js'
import {
  createRoleTemplate,
  createWorker,
  deleteWorker,
  listWorkers,
  updateRoleTemplate,
} from '../../web/src/api.js'
import { ToastProvider } from '../../web/src/ui/useToast.js'
import { AddWorkerDialog } from '../../web/src/worker/AddWorkerDialog.js'
import { useWorkerActions } from '../../web/src/worker/useWorkerActions.js'
import { useWorkerComposer } from '../../web/src/worker/useWorkerComposer.js'
import { fetchWithNodeSignal } from '../helpers/fetch-with-node-signal.js'
import { startAuthorizedTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Awaited<ReturnType<typeof startAuthorizedTestServer>>[] = []
afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  for (const server of servers.splice(0)) await server.close()
})
const Harness = ({ workspaceId, workers }: { workspaceId: string; workers: TeamListItem[] }) => {
  const [open, setOpen] = useState(true)
  const [workersByWorkspaceId, setWorkersByWorkspaceId] = useState({ [workspaceId]: workers })
  useEffect(() => setWorkersByWorkspaceId({ [workspaceId]: workers }), [workspaceId, workers])
  const actions = useWorkerActions({ activeWorkspaceId: workspaceId, setWorkersByWorkspaceId })
  const composer = useWorkerComposer({
    createWorker: actions.createWorker,
    open,
    workers: workersByWorkspaceId[workspaceId] ?? [],
  })
  return (
    <ToastProvider>
      <button type="button" onClick={() => setOpen(true)}>
        Add another member
      </button>
      {open ? (
        <AddWorkerDialog
          commandPresets={composer.commandPresets}
          commandPresetId={composer.commandPresetId}
          creating={composer.creating}
          customTemplates={composer.customTemplates}
          onApplyMarketplaceImport={composer.applyMarketplaceImport}
          onClose={() => setOpen(false)}
          onDeleteTemplate={composer.deleteTemplate}
          onNameChange={composer.setWorkerName}
          onPresetChange={composer.setCommandPresetId}
          onRandomName={composer.randomizeWorkerName}
          onRoleChange={composer.setWorkerRole}
          onRoleDescriptionChange={composer.setRoleDescription}
          onRoleDescriptionReset={composer.resetRoleDescription}
          onSaveAsTemplate={composer.saveAsTemplate}
          onStartupCommandChange={composer.setStartupCommand}
          onSubmit={(event) => composer.submit(event, () => setOpen(false))}
          onTemplateChange={composer.selectTemplate}
          roleDescription={composer.roleDescription}
          roleDescriptionDefault={composer.roleDescriptionDefault}
          selectedTemplateId={composer.selectedTemplateId}
          startupCommand={composer.startupCommand}
          templateBusy={composer.templateBusy}
          workerName={composer.workerName}
          workerRole={composer.workerRole}
        />
      ) : null}
    </ToastProvider>
  )
}
const setup = async () => {
  const server = await startAuthorizedTestServer()
  servers.push(server)
  const workspace = server.store.createWorkspace(server.dataDir, 'Role naming')
  const preset = server.store.settings.createCommandPreset({
    displayName: 'Fixture Node',
    command: process.execPath,
    args: [],
    env: {},
    resumeArgsTemplate: null,
    sessionIdCapture: null,
    yoloArgsTemplate: [],
  })
  const cookie = await getUiCookie(server.baseUrl, server.store)
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = new Headers(init?.headers)
    headers.set('cookie', cookie)
    return fetchWithNodeSignal(new URL(path, server.baseUrl), { ...init, headers })
  })
  return { server, workspace, preset }
}

test('default member names follow the selected role and persist through the real creation route', async () => {
  const { workspace, preset } = await setup()
  render(<Harness workspaceId={workspace.id} workers={await listWorkers(workspace.id)} />)
  const name = screen.getByPlaceholderText('e.g. Alice')
  await waitFor(() => expect(name).toHaveValue('Coder'))
  fireEvent.click(screen.getByTestId('role-card-reviewer'))
  expect(name).toHaveValue('Reviewer')
  fireEvent.click(screen.getByTestId('role-card-tester'))
  expect(name).toHaveValue('Tester')
  fireEvent.click(await screen.findByTestId(`agent-radio-${preset.id}`))
  fireEvent.click(screen.getByTestId('add-worker-submit'))
  await waitFor(() => expect(screen.queryByRole('form', { name: 'Add team member' })).toBeNull())
  expect(await listWorkers(workspace.id)).toEqual([
    expect.objectContaining({ name: 'Tester', role: 'tester' }),
  ])
  fireEvent.click(screen.getByRole('button', { name: 'Add another member' }))
  await waitFor(() => expect(screen.getByPlaceholderText('e.g. Alice')).toHaveValue('Coder'))
  fireEvent.click(screen.getByTestId('role-card-tester'))
  expect(screen.getByPlaceholderText('e.g. Alice')).toHaveValue('Tester 2')
}, 30000)

test('automatic names remain stable during list changes, avoid new collisions, and preserve manual input', async () => {
  const { workspace, preset } = await setup()
  const first = await createWorker(workspace.id, {
    name: 'Coder',
    role: 'coder',
    command_preset_id: preset.id,
    autostart: false,
  })
  await createWorker(workspace.id, {
    name: 'Coder 2',
    role: 'coder',
    command_preset_id: preset.id,
    autostart: false,
  })
  const view = render(
    <Harness workspaceId={workspace.id} workers={await listWorkers(workspace.id)} />
  )
  const name = screen.getByPlaceholderText('e.g. Alice')
  await waitFor(() => expect(name).toHaveValue('Coder 3'))
  await deleteWorker(workspace.id, first.worker.id)
  view.rerender(<Harness workspaceId={workspace.id} workers={await listWorkers(workspace.id)} />)
  expect(name).toHaveValue('Coder 3')
  await createWorker(workspace.id, {
    name: 'Coder 3',
    role: 'coder',
    command_preset_id: preset.id,
    autostart: false,
  })
  view.rerender(<Harness workspaceId={workspace.id} workers={await listWorkers(workspace.id)} />)
  await waitFor(() => expect(name).toHaveValue('Coder'))
  fireEvent.change(name, { target: { value: 'My reviewer' } })
  fireEvent.click(screen.getByTestId('role-card-reviewer'))
  view.rerender(<Harness workspaceId={workspace.id} workers={await listWorkers(workspace.id)} />)
  expect(name).toHaveValue('My reviewer')
  fireEvent.click(await screen.findByTestId(`agent-radio-${preset.id}`))
  fireEvent.click(screen.getByTestId('add-worker-submit'))
  await waitFor(() => expect(screen.queryByRole('form', { name: 'Add team member' })).toBeNull())
  expect((await listWorkers(workspace.id)).map((worker) => worker.name)).toEqual([
    'Coder 2',
    'Coder 3',
    'My reviewer',
  ])
}, 30000)

test('saved templates provide default names, refresh changed configuration, and never replace a manually entered name', async () => {
  const { workspace, preset } = await setup()
  const template = await createRoleTemplate({
    name: 'Doc Writer',
    roleType: 'custom',
    description: 'Writes project documentation',
  })
  await createWorker(workspace.id, {
    name: 'Doc Writer',
    role: 'custom',
    command_preset_id: preset.id,
    autostart: false,
  })
  render(<Harness workspaceId={workspace.id} workers={await listWorkers(workspace.id)} />)
  fireEvent.click(screen.getByTestId('role-card-custom'))
  await waitFor(() => expect(screen.getByPlaceholderText('e.g. Alice')).toHaveValue('Custom'))
  fireEvent.click(screen.getByTestId('role-template-picker-trigger'))
  fireEvent.click(await screen.findByTestId(`role-template-option-${template.id}`))
  expect(screen.getByPlaceholderText('e.g. Alice')).toHaveValue('Doc Writer 2')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await updateRoleTemplate(template.id, {
    name: 'Release Writer',
    roleType: 'custom',
    description: 'Writes release documentation',
  })
  fireEvent.click(screen.getByRole('button', { name: 'Add another member' }))
  await waitFor(() =>
    expect(screen.getByPlaceholderText('e.g. Alice')).toHaveValue('Release Writer')
  )
  fireEvent.change(screen.getByPlaceholderText('e.g. Alice'), {
    target: { value: 'User chosen name' },
  })
  fireEvent.click(screen.getByTestId('role-template-picker-trigger'))
  fireEvent.click(screen.getByTestId('role-template-clear'))
  expect(screen.getByPlaceholderText('e.g. Alice')).toHaveValue('User chosen name')
  fireEvent.click(screen.getByTestId('role-template-picker-trigger'))
  fireEvent.click(screen.getByTestId(`role-template-option-${template.id}`))
  expect(screen.getByPlaceholderText('e.g. Alice')).toHaveValue('User chosen name')
  fireEvent.click(screen.getByRole('button', { name: 'Use a name matching this role' }))
  expect(screen.getByPlaceholderText('e.g. Alice')).toHaveValue('Release Writer')
  fireEvent.click(screen.getByTestId('role-template-picker-trigger'))
  fireEvent.click(screen.getByTestId('role-template-clear'))
  expect(screen.getByPlaceholderText('e.g. Alice')).toHaveValue('Custom')
  fireEvent.click(screen.getByTestId('role-template-save'))
  fireEvent.change(screen.getByTestId('role-template-save-name'), {
    target: { value: 'Release coordinator' },
  })
  fireEvent.click(screen.getByTestId('role-template-save-confirm'))
  await waitFor(() =>
    expect(screen.getByPlaceholderText('e.g. Alice')).toHaveValue('Release coordinator')
  )
  fireEvent.click(await screen.findByTestId(`agent-radio-${preset.id}`))
  fireEvent.click(screen.getByTestId('add-worker-submit'))
  await waitFor(() => expect(screen.queryByRole('form', { name: 'Add team member' })).toBeNull())
  expect(await listWorkers(workspace.id)).toEqual([
    expect.objectContaining({ name: 'Doc Writer', role: 'custom' }),
    expect.objectContaining({ name: 'Release coordinator', role: 'custom' }),
  ])
}, 30000)
