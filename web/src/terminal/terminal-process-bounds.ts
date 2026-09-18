import type { IBuffer } from '@xterm/xterm'
import type { ConversationTurn } from '../../../src/shared/agent-conversation.js'

const normalize = (text: string) => text.replace(/[\s`*_#~•●·]/g, '')
const prefix = (text: string) => normalize(text).slice(0, 100)
const joined = (buffer: IBuffer, row: number) => {
  let text = ''
  for (let index = row; index < Math.min(buffer.length, row + 12); index++) {
    if (index > row && !buffer.getLine(index)?.isWrapped) break
    text += buffer.getLine(index)?.translateToString(true) ?? ''
  }
  return normalize(text)
}

/** Fail open when the completed native answer cannot be located unambiguously. */
export const findTerminalProcessBounds = (buffer: IBuffer, turn: ConversationTurn) => {
  if (buffer.type !== 'normal' || turn.status !== 'complete' || !turn.process.length) return null
  const prompt = prefix(turn.prompt)
  const answerLine = turn.answer.split(/\r?\n/).find((line) => normalize(line).length >= 6)
  const answer = prefix(answerLine ?? '')
  if (!prompt || !answer) return null
  const first = Math.max(0, buffer.length - 2000)
  let promptRow = -1
  for (let row = buffer.length - 1; row >= first; row--) {
    const text = buffer.getLine(row)?.translateToString(true) ?? ''
    if (/^\s*[›❯]\s/.test(text) && joined(buffer, row).replace(/^[›❯]/, '').startsWith(prompt)) {
      promptRow = row
      break
    }
  }
  if (promptRow < 0) return null
  let processRow = promptRow + 1
  while (buffer.getLine(processRow)?.isWrapped) processRow++
  const matches: number[] = []
  for (let row = processRow; row < buffer.length; row++) {
    if (buffer.getLine(row)?.isWrapped) continue
    const text = buffer.getLine(row)?.translateToString(true) ?? ''
    // Require an assistant-cell prefix; duplicate quoted answers remain expanded.
    if (!/^\s*[•●·]\s/.test(text) || !joined(buffer, row).startsWith(answer)) continue
    matches.push(row)
  }
  const answerRow = matches[0]
  if (matches.length !== 1 || answerRow === undefined || answerRow - processRow < 2) return null
  return { promptRow, answerRow, hiddenRows: answerRow - processRow }
}
