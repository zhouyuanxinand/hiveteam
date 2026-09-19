import type { TerminalHistoryBlock } from './terminal-process-bounds.js'
import type { TerminalProcessLabels } from './terminal-process-fold.js'

type BlockView = {
  element: HTMLElement
  text: HTMLElement
  summary?: HTMLElement
  count?: HTMLElement
}

/** DOM text is deliberately used here: terminal output is untrusted, not HTML. */
export const createTerminalProcessHistory = (container: HTMLElement) => {
  const region = document.createElement('div')
  region.className = 'terminal-process-history'
  region.setAttribute('role', 'region')
  region.tabIndex = 0
  region.hidden = true
  const content = document.createElement('div')
  content.className = 'terminal-process-history__content'
  region.append(content)
  container.append(region)
  const views = new Map<string, BlockView>()
  const stopWheel = (event: WheelEvent) => event.stopPropagation()
  region.addEventListener('wheel', stopWheel, { passive: true })

  const hasSelection = () => {
    const selection = document.getSelection()
    return Boolean(
      selection &&
        !selection.isCollapsed &&
        (region.contains(selection.anchorNode) || region.contains(selection.focusNode))
    )
  }

  const createView = (block: TerminalHistoryBlock): BlockView => {
    const text = document.createElement('pre')
    if (block.kind !== 'tool') {
      text.className = `terminal-process-history__${block.kind}`
      return { element: text, text }
    }
    const element = document.createElement('details')
    element.className = 'terminal-process-history__call'
    const summary = document.createElement('summary')
    const label = document.createElement('span')
    const count = document.createElement('span')
    count.className = 'terminal-process-history__count'
    summary.append(label, count)
    text.className = 'terminal-process-history__output'
    element.append(summary, text)
    return { element, text, summary: label, count }
  }

  return {
    hasSelection,
    hide() {
      region.hidden = true
    },
    render(blocks: TerminalHistoryBlock[], labels: TerminalProcessLabels) {
      const follow =
        region.hidden || region.scrollHeight - region.scrollTop - region.clientHeight < 24
      region.setAttribute('aria-label', labels.history)
      const remaining = new Set(views.keys())
      let position = content.firstChild
      for (const block of blocks) {
        let view = views.get(block.id)
        if (!view) {
          view = createView(block)
          views.set(block.id, view)
        }
        remaining.delete(block.id)
        if (view.text.textContent !== block.text) view.text.textContent = block.text
        if (view.summary) view.summary.textContent = labels.internalCall
        if (view.count)
          view.count.textContent = labels.lines.replace(
            '{count}',
            String(block.text.split('\n').length)
          )
        if (view.element !== position) content.insertBefore(view.element, position)
        position = view.element.nextSibling
      }
      for (const id of remaining) {
        views.get(id)?.element.remove()
        views.delete(id)
      }
      region.hidden = false
      if (follow) region.scrollTop = region.scrollHeight
    },
    dispose() {
      region.removeEventListener('wheel', stopWheel)
      region.remove()
      views.clear()
    },
  }
}
