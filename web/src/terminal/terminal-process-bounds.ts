import type { IBuffer } from '@xterm/xterm'

export interface TerminalHistoryBlock {
  id: string
  kind: 'message' | 'prompt' | 'tool'
  text: string
}

const prompt = /^\s?[›❯](?: |$)/u
const cell = /^\s?[•●·] /u
const tool = /^\s?[•●·] (?:Ran|Running|Called|Calling|Explored)\b/u

/** Project scrollback only when the cursor identifies a native CLI composer.
 * Approval screens, full-screen TUIs and ordinary shells keep their original view.
 */
export const readTerminalProcessHistory = (buffer: IBuffer) => {
  if (buffer.type !== 'normal' || buffer.viewportY !== buffer.baseY) return null
  let composerRow = buffer.baseY + buffer.cursorY
  while (composerRow > 0 && buffer.getLine(composerRow)?.isWrapped) composerRow--
  if (!prompt.test(buffer.getLine(composerRow)?.translateToString(true) ?? '')) return null
  if (composerRow <= buffer.viewportY) return null

  const blocks: TerminalHistoryBlock[] = []
  let current: TerminalHistoryBlock | undefined
  for (let row = 0; row < composerRow; row++) {
    let text = ''
    do {
      const wrapped = row + 1 < composerRow && buffer.getLine(row + 1)?.isWrapped
      text += buffer.getLine(row)?.translateToString(!wrapped) ?? ''
      if (!wrapped) break
      row++
    } while (row < composerRow)

    const kind = tool.test(text) ? 'tool' : prompt.test(text) ? 'prompt' : 'message'
    const boundary = kind !== 'message' || cell.test(text) || /^\s*■/u.test(text)
    if (!current || boundary) {
      current = { id: `${blocks.length}:${kind}`, kind, text }
      blocks.push(current)
    } else {
      current.text += `\n${text}`
    }
  }
  for (const block of blocks) block.text = block.text.trimEnd()
  if (!blocks.some((block) => block.kind === 'tool')) return null
  return { composerRow, blocks: blocks.filter((block) => block.text) }
}
