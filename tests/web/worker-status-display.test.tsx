// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { TeamListItem } from '../../src/shared/types.js'
import type { TerminalRunSummary } from '../../web/src/api.js'
import { WorkerCard } from '../../web/src/worker/WorkerCard.js'
import { WorkersPane } from '../../web/src/worker/WorkersPane.js'

afterEach(() => {
  cleanup()
})

const worker = (overrides: Partial<TeamListItem> = {}): TeamListItem => ({
  id: 'worker-1',
  name: 'ember-check-23',
  pendingTaskCount: 0,
  role: 'coder',
  status: 'idle',
  ...overrides,
})

const terminalRun = (agentId: string): TerminalRunSummary => ({
  agent_id: agentId,
  agent_name: agentId,
  run_id: `run-${agentId}`,
  status: 'running',
})

describe('worker status presentation', () => {
  test('worker card keeps an idle worker idle even when its PTY is running', () => {
    render(
      <WorkerCard
        hasRun
        onClick={vi.fn()}
        onAction={vi.fn()}
        worker={worker({ id: 'idle-worker', status: 'idle' })}
      />
    )

    expect(screen.getByRole('status')).toHaveTextContent('idle')
    expect(screen.getByTestId('worker-card-idle-worker')).toHaveAttribute('data-status', 'idle')
    expect(screen.queryByLabelText('Start ember-check-23')).toBeNull()
  })

  test('worker card shows pending dispatch activity without inventing a fourth status', () => {
    render(
      <WorkerCard
        hasRun
        onClick={vi.fn()}
        worker={worker({ pendingTaskCount: 2, status: 'idle' })}
      />
    )

    const statuses = screen.getAllByRole('status')
    expect(statuses[0]).toHaveTextContent('idle')
    expect(screen.getByText('2 pending dispatches')).toBeInTheDocument()
  })

  test('worker name is edited directly inside its card', async () => {
    const onRenameWorker = vi.fn().mockResolvedValue({ error: null })
    render(
      <WorkersPane
        onAddWorkerClick={vi.fn()}
        onDeleteWorker={vi.fn()}
        onOpenWorker={vi.fn()}
        onRenameWorker={onRenameWorker}
        onStartWorker={vi.fn()}
        startingWorkerId={null}
        terminalRuns={[]}
        workers={[worker()]}
      />
    )

    fireEvent.click(screen.getByTestId('worker-card-rename-worker-1'))
    const input = screen.getByTestId('worker-card-rename-input-worker-1')
    fireEvent.change(input, { target: { value: 'ember-renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(onRenameWorker).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'worker-1' }),
        'ember-renamed'
      )
    })
  })

  test('workers pane groups idle running PTYs separately from active work', () => {
    const idleWorker = worker({ id: 'idle-worker', name: 'idle-agent', status: 'idle' })
    const activeWorker = worker({ id: 'active-worker', name: 'active-agent', status: 'working' })
    const stoppedWorker = worker({
      id: 'stopped-worker',
      name: 'stopped-agent',
      status: 'stopped',
    })

    render(
      <WorkersPane
        onAddWorkerClick={vi.fn()}
        onDeleteWorker={vi.fn()}
        onOpenWorker={vi.fn()}
        onRenameWorker={vi.fn()}
        onStartWorker={vi.fn()}
        startingWorkerId={null}
        terminalRuns={[terminalRun(idleWorker.id), terminalRun(activeWorker.id)]}
        workers={[idleWorker, activeWorker, stoppedWorker]}
      />
    )

    expect(screen.getByRole('list', { name: 'running team members' })).toBeInTheDocument()
    const idleList = screen.getByRole('list', { name: 'idle team members' })
    expect(screen.getByRole('list', { name: 'stopped team members' })).toBeInTheDocument()

    expect(within(idleList).getByText('idle-agent')).toBeInTheDocument()
    expect(within(idleList).queryByText('active-agent')).toBeNull()
  })
})
