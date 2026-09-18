import type { Terminal } from '@xterm/xterm'
import type { ConversationTurn } from '../../../src/shared/agent-conversation.js'
import { findTerminalProcessBounds } from './terminal-process-bounds.js'

/** Crop the finished viewport only. Never splice xterm's buffer, replay bytes, or inject input. */
export const createTerminalProcessFold = (terminal: Terminal, container: HTMLElement) => {
  let turn: ConversationTurn | undefined
  let label = ''
  let suppressed: string | undefined
  let folded: ReturnType<typeof findTerminalProcessBounds> = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let programmaticScroll = false
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'terminal-process-fold'
  button.hidden = true
  button.setAttribute('aria-expanded', 'false')
  container.appendChild(button)

  const reveal = (suppress = false) => {
    clearTimeout(timer)
    if (suppress) suppressed = turn?.id
    folded = null
    delete container.dataset.processCollapsed
    container.style.removeProperty('--terminal-process-offset')
    button.hidden = true
  }
  const fold = () => {
    if (!turn || turn.status !== 'complete' || suppressed === turn.id || folded) return
    const buffer = terminal.buffer.active
    if (terminal.hasSelection() || buffer.viewportY !== buffer.baseY) return
    const bounds = findTerminalProcessBounds(buffer, turn)
    const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen')
    if (
      !bounds ||
      !screen?.clientHeight ||
      container.closest('[hidden], [data-terminal-host-parked="true"]')
    )
      return
    if (bounds.answerRow < buffer.baseY) {
      programmaticScroll = true
      terminal.scrollToLine(bounds.answerRow)
      programmaticScroll = false
    }
    const offset =
      (Math.max(0, bounds.answerRow - buffer.viewportY) * screen.clientHeight) / terminal.rows
    container.style.setProperty('--terminal-process-offset', `${offset}px`)
    container.dataset.processCollapsed = 'true'
    button.textContent = label
    button.hidden = false
    folded = bounds
  }
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(fold, 200)
  }
  const input = () => {
    if (folded) terminal.scrollToBottom()
    reveal(true)
  }
  const keydown = (event: KeyboardEvent) => {
    if (event.target === button) return
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === 'c' &&
      terminal.hasSelection()
    )
      return
    input()
  }
  const expand = () => {
    const row = folded?.promptRow
    reveal(true)
    if (row !== undefined) terminal.scrollToLine(row)
    terminal.focus()
  }
  const wheel = () => reveal(true)
  button.addEventListener('click', expand)
  container.addEventListener('keydown', keydown, true)
  container.addEventListener('compositionstart', input, true)
  container.addEventListener('paste', input, true)
  container.addEventListener('wheel', wheel, { capture: true, passive: true })
  const scroll = terminal.onScroll(() => {
    if (!programmaticScroll && folded) reveal(true)
  })
  return {
    update(next: ConversationTurn | undefined, nextLabel: string) {
      if (turn?.id !== next?.id || next?.status !== 'complete') reveal()
      turn = next
      label = nextLabel
      button.textContent = label
      schedule()
    },
    beforeOutput: () => reveal(),
    afterOutput: schedule,
    resize: () => {
      reveal()
      schedule()
    },
    dispose() {
      reveal()
      scroll.dispose()
      button.removeEventListener('click', expand)
      container.removeEventListener('keydown', keydown, true)
      container.removeEventListener('compositionstart', input, true)
      container.removeEventListener('paste', input, true)
      container.removeEventListener('wheel', wheel, true)
      button.remove()
    },
  }
}
