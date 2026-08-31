// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { TeamListItem } from '../../src/shared/types.js'
import { WorkerModal } from '../../web/src/worker/WorkerModal.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const buildWorker = (overrides: Partial<TeamListItem> = {}): TeamListItem => ({
  id: 'worker-1',
  name: 'Alice',
  pendingTaskCount: 0,
  role: 'coder',
  status: 'working',
  ...overrides,
})

const renderModal = (
  options: {
    worker?: TeamListItem
    runId?: string | null
    starting?: boolean
    startError?: string | null
  } = {}
) => {
  const onClose = vi.fn()
  const onStart = vi.fn()
  render(
    <WorkerModal
      onClose={onClose}
      onStart={onStart}
      runId={options.runId === undefined ? 'run-1' : options.runId}
      startError={options.startError ?? null}
      starting={options.starting ?? false}
      worker={options.worker ?? buildWorker()}
    />
  )
  return { onClose, onStart }
}

describe('WorkerModal — pure PTY view (control actions live on WorkerCard)', () => {
  test('mounts the PTY slot when runId is provided', () => {
    const runId = 'run-abc'
    renderModal({ runId })
    const slot = document.getElementById(`worker-pty-${runId}`)
    expect(slot).not.toBeNull()
    expect(slot?.getAttribute('data-pty-slot')).toBe('worker')
  })

  test('renders the empty-state Start affordance when no PTY is running', () => {
    const stoppedWorker = buildWorker({ status: 'stopped' })
    const { onStart } = renderModal({ runId: null, worker: stoppedWorker })

    fireEvent.click(screen.getByTestId('worker-start-empty'))
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onStart).toHaveBeenCalledWith(stoppedWorker)
  })

  test('touch-only close affordance dispatches onClose via Dialog close', () => {
    const { onClose } = renderModal()
    expect(screen.getByTestId('worker-modal-close')).toHaveClass('worker-modal__close')
    fireEvent.click(screen.getByTestId('worker-modal-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('Escape inside the terminal modal is reserved for the terminal instead of dialog close', () => {
    const { onClose } = renderModal({ runId: 'run-1' })

    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'Escape',
      key: 'Escape',
    })
    screen.getByRole('dialog', { name: 'Alice' }).dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
  })

  test('Close tooltip does not advertise Escape as a worker-modal shortcut', () => {
    vi.useFakeTimers()
    renderModal({ runId: 'run-1' })

    fireEvent.focus(screen.getByTestId('worker-modal-close'))
    act(() => vi.advanceTimersByTime(300))

    expect(screen.getAllByText('Close').length).toBeGreaterThan(0)
    expect(screen.queryByText('Close (Esc)')).toBeNull()

    vi.useRealTimers()
  })

  test('startError surfaces as an alert banner', () => {
    renderModal({ startError: 'claude CLI not found in PATH', runId: null })
    expect(screen.getByRole('alert')).toHaveTextContent('claude CLI not found in PATH')
  })

  test('control actions (Stop / Restart / Delete) are NOT rendered inside the modal', () => {
    renderModal()
    expect(screen.queryByTestId('worker-stop')).toBeNull()
    expect(screen.queryByTestId('worker-restart')).toBeNull()
    expect(screen.queryByTestId('worker-delete')).toBeNull()
    // (Card-level testids: worker-card-stop-*, worker-card-restart-*, worker-card-delete-*)
  })
})
