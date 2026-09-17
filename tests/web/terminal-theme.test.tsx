// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import type { IDecoration, IDecorationOptions, Terminal } from '@xterm/xterm'
import { afterEach, expect, test, vi } from 'vitest'
import { TerminalView } from '../../web/src/terminal/TerminalView.js'
import { applyUiTheme } from '../../web/src/theme.js'

let terminal: Terminal
const decorations: { decoration: IDecoration; options: IDecorationOptions }[] = []

// Keep xterm's real parser, buffer, markers and decorations. Only its canvas
// host and optional rendering addons are isolated from jsdom.
vi.mock('@xterm/xterm', async (importOriginal) => {
  const original = await importOriginal<typeof import('@xterm/xterm')>()
  return {
    Terminal: class extends original.Terminal {
      constructor(options: ConstructorParameters<typeof original.Terminal>[0]) {
        super(options)
        terminal = this
      }
      open() {}
      loadAddon(addon: Parameters<Terminal['loadAddon']>[0]) {
        if (typeof addon.activate === 'function') super.loadAddon(addon)
      }
      focus() {}
      blur() {}
      refresh() {}
      registerDecoration(options: Parameters<Terminal['registerDecoration']>[0]) {
        const decoration = super.registerDecoration(options)
        if (decoration) decorations.push({ decoration, options })
        return decoration
      }
    },
  }
})
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
    dispose() {}
  },
}))
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: class {} }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss() {}
  },
}))

class Socket {
  static all: Socket[] = []
  readonly OPEN = 1
  readyState = 1
  onmessage: ((event: { data: string }) => void) | null = null
  onopen: (() => void) | null = null
  constructor(readonly url: string) {
    Socket.all.push(this)
    queueMicrotask(() => this.onopen?.())
  }
  send() {}
  close() {
    this.readyState = 3
  }
}

const theme = (value: 'light' | 'dark') => {
  const root = document.documentElement
  root.style.setProperty('--bg-2', value === 'light' ? '#eef1f5' : '#1d1d1d')
  root.style.setProperty('--bg-crust', value === 'light' ? '#e9edf2' : '#0e0e0e')
  root.style.setProperty('--text-primary', value === 'light' ? '#17202a' : '#ebebeb')
  root.style.setProperty('--accent', '#3358d4')
  applyUiTheme(value)
}
const active = () =>
  decorations.filter(({ decoration }) => !decoration.isDisposed && !decoration.marker.isDisposed)
const write = async (chunk: string, restore = false) => {
  const socket = Socket.all.find((s) => s.url.includes(restore ? '/control?' : '/io?'))
  if (!socket) throw new Error('Expected terminal socket')
  await act(async () => {
    socket.onmessage?.({
      data: restore ? JSON.stringify({ type: 'restore', snapshot: chunk }) : chunk,
    })
    await new Promise<void>((resolve) => terminal.write('', resolve))
  })
}
const mount = async () => {
  vi.stubGlobal('WebSocket', Socket)
  const host = document.createElement('div')
  host.id = 'orch-pty-theme-test'
  document.body.append(host)
  theme('dark')
  render(<TerminalView runId="theme-test" title="Theme test" />)
  await waitFor(() => expect(Socket.all).toHaveLength(2))
  await write('› hello\r\n', true)
  await waitFor(() => expect(active()).toHaveLength(1))
}

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  document.documentElement.removeAttribute('style')
  delete document.documentElement.dataset.hiveTheme
  decorations.length = 0
  Socket.all = []
  vi.unstubAllGlobals()
})

test('updates existing input highlights and ANSI colors in both theme directions', async () => {
  await mount()
  const darkGreen = terminal.options.theme?.green
  act(() => theme('light'))
  await waitFor(() => expect(active()[0]?.options.backgroundColor).toBe('#eef1f5'))
  expect(terminal.options.theme?.background).toBe('#e9edf2')
  expect(terminal.options.theme?.green).toBeDefined()
  expect(terminal.options.theme?.green).not.toBe(darkGreen)
  act(() => theme('dark'))
  await waitFor(() => expect(active()[0]?.options.backgroundColor).toBe('#1d1d1d'))
  expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('› hello')
})

test('removes highlights when the CLI overwrites an input line', async () => {
  await mount()
  await write('\x1b[1;1H\x1b[2KTool output')
  await waitFor(() => expect(active()).toHaveLength(0))
  expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('Tool output')
})

test('does not insert RGB escapes into streamed input-looking text', async () => {
  await mount()
  expect(terminal.buffer.active.getLine(0)?.getCell(0)?.isFgDefault()).toBe(true)
})

test('resizes highlights without leaving the old width behind', async () => {
  await mount()
  act(() => {
    terminal.resize(100, 24)
    window.dispatchEvent(new Event('resize'))
  })
  await waitFor(() => expect(active()[0]?.options.width).toBe(100))
  expect(active()).toHaveLength(1)
  expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('› hello')
})

test('clears decorations in the alternate buffer and rebuilds them on return', async () => {
  await mount()
  await write('\x1b[?1049hFull screen CLI view')
  await waitFor(() => expect(active()).toHaveLength(0))
  expect(terminal.buffer.active.type).toBe('alternate')
  await write('\x1b[?1049l')
  await waitFor(() => expect(active()).toHaveLength(1))
  expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('› hello')
})
