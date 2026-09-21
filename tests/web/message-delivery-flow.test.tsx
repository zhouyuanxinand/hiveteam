// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { MessageDeliveryPanel } from '../../web/src/activity/MessageDeliveryPanel.js'
import { ResourceStatusButton } from '../../web/src/resources/ResourceStatusButton.js'
import { startAuthorizedTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const nativeFetch = globalThis.fetch
const servers: Awaited<ReturnType<typeof startAuthorizedTestServer>>[] = []
afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  for (const server of servers.splice(0)) await server.close()
})
const setup = async () => {
  const server = await startAuthorizedTestServer()
  servers.push(server)
  const workspace = server.store.createWorkspace(server.dataDir, 'Delivery UI')
  const worker = server.store.addWorker(workspace.id, { name: 'Delivery coder', role: 'coder' })
  server.store.configureAgentLaunch(workspace.id, worker.id, {
    command: process.execPath,
    args: [
      '-e',
      "process.stdout.write('ready'); process.stdin.resume(); setInterval(() => {}, 1000)",
    ],
  })
  const run = await server.store.startAgent(workspace.id, worker.id, {
    hivePort: new URL(server.baseUrl).port,
  })
  const cookie = await getUiCookie(server.baseUrl)
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = new Headers(init?.headers)
    headers.set('cookie', cookie)
    return nativeFetch(new URL(path, server.baseUrl), { ...init, headers })
  })
  return { server, workspace, worker, run }
}

test('manual delivery review preserves the task outcome and polling preserves edited reminder values', async () => {
  const f = await setup()
  const task = await f.server.store.dispatchTask(
    f.workspace.id,
    f.worker.id,
    'Inspect the delivery fixture'
  )
  await expect
    .poll(() => f.server.store.dispatchDelivery.records.get(task.id)?.state)
    .toBe('unknown')
  render(<MessageDeliveryPanel workspaceId={f.workspace.id} />)
  await screen.findByText('Receipt unconfirmed')
  expect(screen.queryByText('Receipt confirmed')).toBeNull()
  fireEvent.click(screen.getByText('Task reminder settings'))
  const taskSection = screen.getByText('Inspect the delivery fixture').closest('li')
  if (!taskSection) throw new Error('Expected task section')
  const duration = within(taskSection).getByRole('spinbutton', {
    name: 'Execution reminder (seconds)',
  })
  fireEvent.change(duration, { target: { value: '123' } })
  await new Promise((resolve) => setTimeout(resolve, 2200))
  expect(duration).toHaveValue(123)
  fireEvent.click(screen.getByRole('button', { name: 'Review manually' }))
  expect(screen.getByRole('button', { name: 'Mark handled' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Resend with original ID' })).toBeDisabled()
  fireEvent.change(screen.getByRole('textbox', { name: 'Reason' }), {
    target: { value: 'Checked the terminal; the original task is present' },
  })
  fireEvent.click(screen.getByRole('checkbox', { name: /I checked receipt/ }))
  expect(screen.getByRole('button', { name: 'Resend with original ID' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Mark handled' }))
  await screen.findByText('No deliveries need attention.')
  expect(f.server.store.dispatchDelivery.records.get(task.id)).toMatchObject({
    state: 'resolved',
    evidence: 'manual',
    attempt: 1,
  })
  expect(f.server.store.getDispatch(f.workspace.id, task.id)?.status).toBe('submitted')
  expect(f.server.store.getWorker(f.workspace.id, f.worker.id).pendingTaskCount).toBe(1)
}, 20_000)

test('resource stop shows other open tasks and cancellation leaves the process running', async () => {
  const f = await setup()
  await f.server.store.dispatchTask(f.workspace.id, f.worker.id, 'Login repair')
  await f.server.store.dispatchTask(f.workspace.id, f.worker.id, 'Regression checks')
  render(<ResourceStatusButton />)
  fireEvent.click(screen.getByRole('button', { name: 'Runtime resources' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Stop Delivery coder' }))
  const dialog = await screen.findByRole('dialog', { name: 'Stop the whole worker?' })
  expect(within(dialog).getByText('Login repair')).toBeVisible()
  expect(within(dialog).getByText('Regression checks')).toBeVisible()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Keep running' }))
  expect(f.server.store.getLiveRun(f.run.runId).status).toBe('running')
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Stop Delivery coder' })).toBeEnabled()
  )
  fireEvent.click(screen.getByRole('button', { name: 'Stop Delivery coder' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Stop worker' }))
  await waitFor(() => expect(f.server.store.getLiveRun(f.run.runId).status).toBe('exited'), {
    timeout: 6000,
  })
  expect(f.server.store.listWorkers(f.workspace.id)[0]?.pendingTaskCount).toBe(2)
}, 20_000)
