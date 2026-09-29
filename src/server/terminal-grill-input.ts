import { clarificationSkillNames, isClarificationSkill } from '../shared/clarification.js'
import { isTerminalReplyOnly } from './terminal-input-classification.js'

const ESC = '\u001b'
const PASTE_START = `${ESC}[200~`
const PASTE_END = `${ESC}[201~`

export const isTerminalGrillCompletionPrefix = (text: string) => {
  if (!/^\$[a-zA-Z0-9/_-]+$/u.test(text)) return false
  const name = text.slice(1).split('/').at(-1) ?? ''
  return name.length > 0 && clarificationSkillNames.some((skill) => skill.startsWith(name))
}

export const parseTerminalGrill = (text: string) => {
  const match = /^\s*\$([^\s]+)(?:[ \t]+([^\r\n]*))?\s*$/u.exec(text)
  if (!match?.[1] || !isClarificationSkill(match[1]) || /[\r\n]/u.test(text)) return null
  return { skill: match[1], brief: match[2]?.trim() ?? '' }
}

/** Only the currently visible composer can authorize interception. Older ›
 * lines, pasted-content placeholders and multiline drafts are not sufficient. */
export const readTerminalGrillComposer = (screen: string) => {
  const lines = screen.split('\n')
  let index = lines.length - 1
  while (index >= 0 && !/^\s*›/u.test(lines[index] ?? '')) index -= 1
  if (index < 0) return null
  const text = (lines[index] ?? '').replace(/^\s*›\s?/u, '').trimEnd()
  const footer = lines.slice(index + 1).filter((line) => line.trim())
  const first = footer[0]?.trim() ?? ''
  // A second draft line precedes the model/shortcut footer in Codex. Do not
  // clear it using single-line editor shortcuts.
  if (
    first &&
    !/^(?:\d+% context|\d+[.,\d]* tokens|[?？]|[←↔]|GPT-|gpt-|OpenAI|Press |ctrl[+ ]|shift[+ ]|esc[ /]|enter[ /]|tab[ /]|[⏵▸])/iu.test(
      first
    )
  )
    return null
  return {
    text,
    pastedCharacters: /^\[Pasted Content ([\d,]+) chars\]$/u.test(text)
      ? Number(/^\[Pasted Content ([\d,]+) chars\]$/u.exec(text)?.[1]?.replaceAll(',', ''))
      : null,
    blocked:
      /This conversation is open in another app|Do you trust the contents of this directory\?|Hooks need review|Press enter to confirm/iu.test(
        screen
      ),
    busy: /esc to interrupt/iu.test(screen),
  }
}

export interface GrillInputToken {
  data: string
  submit: boolean
  paste?: boolean
  /** A split escape is forwarded immediately and observed only when complete. */
  edit?: string | null
}

/** Frame boundaries are transport details. Forward partial escapes immediately,
 * but retain their parsing state so pasted newlines never become submits. */
export class TerminalGrillInput {
  private pending = ''
  private forwarded = 0
  private pasting = false
  private draft: string[] = []
  private cursor = 0
  private known = true
  private unknownCursorAtEnd = false
  private completion: string | null = null

  get text() {
    return this.known ? this.draft.join('') : null
  }

  get completionPrefix() {
    return this.completion
  }

  expectCompletion(prefix: string) {
    this.known = false
    this.unknownCursorAtEnd = false
    this.completion = prefix
  }

  reset(text = '') {
    this.draft = [...text]
    this.cursor = this.draft.length
    this.known = true
    this.unknownCursorAtEnd = false
    this.completion = null
  }

  invalidate() {
    this.known = false
    this.unknownCursorAtEnd = false
    this.completion = null
  }

  tokenize(chunk: string): GrillInputToken[] {
    // xterm emits a plain Escape key on its own. Its byte was already sent;
    // a later printable key starts a new edit, not an invented Alt shortcut.
    // Keep actual CSI/SS3/OSC/DCS introducers pending across split frames.
    if (this.pending === ESC && chunk && !['[', 'O', ']', 'P'].includes(chunk[0] ?? '')) {
      this.pending = ''
      this.forwarded = 0
    }
    this.pending += chunk
    const result: GrillInputToken[] = []
    const take = (count: number, paste = false) => {
      const text = this.pending.slice(0, count)
      result.push({
        data: text.slice(Math.min(this.forwarded, count)),
        edit: text,
        submit: false,
        ...(paste ? { paste: true } : {}),
      })
      this.forwarded = Math.max(0, this.forwarded - count)
      this.pending = this.pending.slice(count)
    }
    const forwardPending = () => {
      const text = this.pending.slice(this.forwarded)
      if (text) result.push({ data: text, edit: null, submit: false })
      this.forwarded = this.pending.length
    }
    while (this.pending) {
      if (this.pasting) {
        const end = this.pending.indexOf(PASTE_END)
        if (end >= 0) {
          if (end) take(end, true)
          take(PASTE_END.length)
          this.pasting = false
          continue
        }
        let suffix = Math.min(PASTE_END.length - 1, this.pending.length)
        while (suffix && !PASTE_END.startsWith(this.pending.slice(-suffix))) suffix -= 1
        const body = this.pending.slice(0, this.pending.length - suffix)
        if (body) take(body.length, true)
        forwardPending()
        break
      }
      if (this.pending.startsWith(ESC)) {
        if (this.pending.length === 1) {
          forwardPending()
          break
        }
        let token: string | undefined
        if (this.pending[1] === '[') {
          // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI input grammar.
          token = /^\u001b\[[0-?]*[ -/]*[@-~]/u.exec(this.pending)?.[0]
          if (!token && this.pending.length < 64) {
            forwardPending()
            break
          }
        } else if (this.pending[1] === 'O') {
          if (this.pending.length < 3) {
            forwardPending()
            break
          }
          token = this.pending.slice(0, 3)
        } else if (this.pending[1] === ']' || this.pending[1] === 'P') {
          const bell = this.pending[1] === ']' ? this.pending.indexOf('\u0007') : -1
          const terminator = this.pending.indexOf(`${ESC}\\`)
          const end = Math.min(
            bell < 0 ? Number.POSITIVE_INFINITY : bell + 1,
            terminator < 0 ? Number.POSITIVE_INFINITY : terminator + 2
          )
          if (!Number.isFinite(end) && this.pending.length < 4096) {
            forwardPending()
            break
          }
          token = this.pending.slice(0, Number.isFinite(end) ? end : 4096)
        }
        token ??= this.pending.slice(0, /[\r\n]/u.test(this.pending[1] ?? '') ? 1 : 2)
        take(token.length)
        if (token === PASTE_START) this.pasting = true
        continue
      }
      const first = this.pending[0] ?? ''
      if (first === '\r' || first === '\n') {
        const count = this.pending.startsWith('\r\n') ? 2 : 1
        result.push({ data: this.pending.slice(0, count), submit: true })
        this.pending = this.pending.slice(count)
        continue
      }
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI input grammar.
      const next = this.pending.search(/[\u001b\r\n]/u)
      const count = next < 0 ? this.pending.length : next
      take(count)
    }
    return result
  }

  observe(token: GrillInputToken) {
    if (token.submit || token.edit === null) return
    const data = token.edit ?? token.data
    if (data === ESC || data === PASTE_START || data === PASTE_END || isTerminalReplyOnly(data))
      return
    if (!this.known) {
      if (token.paste) return
      for (const char of data) {
        this.completion = null
        if (this.known) this.observe({ data: char, submit: false })
        else if (char === '\u0003') this.reset()
        else if (char === '\u0005') this.unknownCursorAtEnd = true
        else if (char === '\u0015' && this.unknownCursorAtEnd) this.reset()
        else this.unknownCursorAtEnd = false
      }
      return
    }
    if (token.paste) {
      const text = [...data.replace(/\r\n?/gu, '\n')]
      this.draft.splice(this.cursor, 0, ...text)
      this.cursor += text.length
      return
    }
    if (data.startsWith(ESC)) {
      if (data === `${ESC}[D`) this.cursor = Math.max(0, this.cursor - 1)
      else if (data === `${ESC}[C`) this.cursor = Math.min(this.draft.length, this.cursor + 1)
      else if ([`${ESC}[H`, `${ESC}[1~`, `${ESC}OH`].includes(data)) this.cursor = 0
      else if ([`${ESC}[F`, `${ESC}[4~`, `${ESC}OF`].includes(data)) this.cursor = this.draft.length
      else if (data === `${ESC}[3~`) this.draft.splice(this.cursor, 1)
      else this.known = false
      return
    }
    for (const char of data) {
      if (!this.known) {
        this.observe({ data: char, submit: false })
        continue
      }
      if (char === '\u007f' || char === '\b') {
        if (this.cursor > 0) this.draft.splice(--this.cursor, 1)
      } else if (char === '\u0001') this.cursor = 0
      else if (char === '\u0005') this.cursor = this.draft.length
      else if (char === '\u0015') {
        this.draft.splice(0, this.cursor)
        this.cursor = 0
      } else if (char === '\u000b') this.draft.splice(this.cursor)
      else if (char === '\u0003') this.reset()
      else if (char < ' ') {
        if (char === '\t' && /^\$[a-zA-Z0-9/_-]+$/u.test(this.draft.join('')))
          this.completion = this.draft.join('')
        this.known = false
      } else {
        this.draft.splice(this.cursor++, 0, char)
      }
    }
    if (this.draft.length > 32_000) this.invalidate()
  }
}
