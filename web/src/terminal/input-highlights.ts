import type { IDecoration, IDecorationOptions, Terminal } from '@xterm/xterm'
import { readTerminalAppearance } from './terminal-theme.js'

const INPUT_LINE = /^\s*[›❯»]\s+\S/
const SCAN_LINES = 2_000

// Decorations are view state, never mutations to the CLI's ANSI stream.
export const createInputHighlights = (terminal: Terminal) => {
  const decorations = new Map<IDecoration, IDecorationOptions>()
  const remove = (decoration: IDecoration) => {
    decorations.delete(decoration)
    decoration.dispose()
    decoration.marker.dispose()
  }
  const clear = () => {
    for (const decoration of decorations.keys()) remove(decoration)
  }
  const refresh = () => {
    const buffer = terminal.buffer.active
    if (buffer.type === 'alternate') {
      clear()
      return
    }
    const { inputBackground, inputForeground } = readTerminalAppearance()
    const first = Math.max(0, buffer.length - SCAN_LINES)
    const wanted = new Set<number>()
    for (let line = first; line < buffer.length; line++) {
      if (INPUT_LINE.test(buffer.getLine(line)?.translateToString(true) ?? '')) wanted.add(line)
    }
    for (const [decoration, options] of decorations) {
      const { marker } = decoration
      if (
        marker.isDisposed ||
        !wanted.has(marker.line) ||
        options.width !== terminal.cols ||
        options.backgroundColor !== inputBackground ||
        options.foregroundColor !== inputForeground
      ) {
        remove(decoration)
      } else wanted.delete(marker.line)
    }
    const cursor = buffer.baseY + buffer.cursorY
    for (const line of wanted) {
      const marker = terminal.registerMarker(line - cursor)
      if (!marker) continue
      const options: IDecorationOptions = {
        marker,
        backgroundColor: inputBackground,
        foregroundColor: inputForeground,
        height: 1,
        layer: 'bottom',
        width: terminal.cols,
        x: 0,
        overviewRulerOptions: { color: inputForeground, position: 'left' },
      }
      const decoration = terminal.registerDecoration(options)
      if (decoration) decorations.set(decoration, options)
      else marker.dispose()
    }
  }
  return { dispose: clear, refresh }
}
