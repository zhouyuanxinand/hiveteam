// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { FsProbeResponse } from '../../web/src/api.js'
import { DesktopFolderDropTarget } from '../../web/src/desktop/DesktopFolderDropTarget.js'

const probe: FsProbeResponse = {
  current_branch: null,
  documents: [],
  exists: true,
  is_dir: true,
  is_git_repository: false,
  ok: true,
  path: 'D:\\桌面\\AI test',
  suggested_name: 'AI test',
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'hiveDesktop')
})

const droppedFolder = new File([], 'AI test')
const transfer = {
  files: [droppedFolder],
  items: [{ kind: 'file' }],
  types: ['Files'],
}

describe('DesktopFolderDropTarget', () => {
  test('is absent in an ordinary browser', () => {
    render(<DesktopFolderDropTarget onError={() => {}} onFolder={() => {}} />)
    fireEvent.dragEnter(window, { dataTransfer: transfer })
    expect(screen.queryByTestId('desktop-folder-drop-overlay')).not.toBeInTheDocument()
  })

  test('resolves an OS-backed folder and returns the exact probe', async () => {
    const probeDroppedFolder = vi.fn(async () => ({ ok: true as const, probe }))
    Object.defineProperty(window, 'hiveDesktop', {
      configurable: true,
      value: { probeDroppedFolder },
    })
    const onFolder = vi.fn()

    render(<DesktopFolderDropTarget onError={() => {}} onFolder={onFolder} />)
    fireEvent.dragEnter(window, { dataTransfer: transfer })
    expect(await screen.findByTestId('desktop-folder-drop-overlay')).toHaveTextContent(
      'Drop folder to add Workspace'
    )
    fireEvent.drop(window, { dataTransfer: transfer })

    await waitFor(() => expect(onFolder).toHaveBeenCalledWith(probe))
    expect(probeDroppedFolder).toHaveBeenCalledWith(droppedFolder)
  })

  test('ignores a stale probe when a newer folder finishes first', async () => {
    let resolveFirst: ((value: { ok: true; probe: FsProbeResponse }) => void) | undefined
    let resolveSecond: ((value: { ok: true; probe: FsProbeResponse }) => void) | undefined
    const secondProbe = { ...probe, path: 'D:\\桌面\\new folder', suggested_name: 'new folder' }
    const probeDroppedFolder = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ ok: true; probe: FsProbeResponse }>((resolveProbe) => {
            resolveFirst = resolveProbe
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<{ ok: true; probe: FsProbeResponse }>((resolveProbe) => {
            resolveSecond = resolveProbe
          })
      )
    Object.defineProperty(window, 'hiveDesktop', {
      configurable: true,
      value: { probeDroppedFolder },
    })
    const onFolder = vi.fn()
    const nextFolder = new File([], 'new folder')
    const nextTransfer = { ...transfer, files: [nextFolder] }

    render(<DesktopFolderDropTarget onError={() => {}} onFolder={onFolder} />)
    fireEvent.dragEnter(window, { dataTransfer: transfer })
    fireEvent.drop(window, { dataTransfer: transfer })
    await waitFor(() => expect(probeDroppedFolder).toHaveBeenCalledTimes(1))
    fireEvent.dragEnter(window, { dataTransfer: nextTransfer })
    fireEvent.drop(window, { dataTransfer: nextTransfer })
    await waitFor(() => expect(probeDroppedFolder).toHaveBeenCalledTimes(2))

    resolveSecond?.({ ok: true, probe: secondProbe })
    await waitFor(() => expect(onFolder).toHaveBeenCalledWith(secondProbe))
    resolveFirst?.({ ok: true, probe })
    await Promise.resolve()
    expect(onFolder).toHaveBeenCalledTimes(1)
  })
})
