import type { Terminal } from '@xterm/xterm'
import { readTerminalProcessHistory } from './terminal-process-bounds.js'
import { createTerminalProcessHistory } from './terminal-process-history.js'
import { readTerminalAppearance } from './terminal-theme.js'

export interface TerminalProcessLabels {
  history: string
  internalCall: string
  lines: string
}

/** Read-only disclosure over scrollback. The original xterm owns every input byte,
 * cursor, native confirmation and history record; its buffer is never rewritten.
 */
export const createTerminalProcessFold = (terminal: Terminal, container: HTMLElement) => {
  const history = createTerminalProcessHistory(container)
  let labels: TerminalProcessLabels | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const revealNative = () => {
    history.hide()
    delete container.dataset.processCollapsed
    container.style.removeProperty('--terminal-history-height')
  }
  const render = () => {
    clearTimeout(timer)
    timer = undefined
    if (disposed) return
    const snapshot = labels ? readTerminalProcessHistory(terminal.buffer.active) : null
    const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen')
    if (
      !labels ||
      !snapshot ||
      !screen?.clientHeight ||
      container.closest('[hidden], [data-terminal-host-parked="true"]')
    ) {
      revealNative()
      return
    }
    if (history.hasSelection() || terminal.hasSelection()) return
    const height =
      (terminal.element?.offsetTop ?? 0) +
      screen.offsetTop +
      ((snapshot.composerRow - terminal.buffer.active.viewportY) * screen.clientHeight) /
        terminal.rows
    container.style.setProperty('--terminal-history-height', `${height}px`)
    const appearance = readTerminalAppearance()
    container.style.setProperty('--terminal-message-accent', appearance.inputForeground)
    container.style.setProperty(
      '--terminal-message-selection',
      appearance.theme.selectionBackground
    )
    history.render(snapshot.blocks, labels)
    container.dataset.processCollapsed = 'true'
  }
  const schedule = () => {
    if (!disposed && timer === undefined) timer = setTimeout(render, 32)
  }
  const scroll = terminal.onScroll(schedule)
  document.addEventListener('selectionchange', schedule)

  return {
    setLabels(next: TerminalProcessLabels | undefined) {
      labels = next
      if (!next) revealNative()
      schedule()
    },
    afterOutput: render,
    resize: schedule,
    hasSelection: history.hasSelection,
    dispose() {
      disposed = true
      clearTimeout(timer)
      scroll.dispose()
      document.removeEventListener('selectionchange', schedule)
      revealNative()
      history.dispose()
    },
  }
}
