import serializeAddonModule from '@xterm/addon-serialize'
import headlessTerminalModule from '@xterm/headless'

const { SerializeAddon } = serializeAddonModule as typeof import('@xterm/addon-serialize')
const { Terminal } = headlessTerminalModule as typeof import('@xterm/headless')

export const TERMINAL_SCROLLBACK = 10_000

export interface TerminalMirrorSize {
  cols: number
  rows: number
}

const normalizeTerminalSize = ({ cols, rows }: TerminalMirrorSize): TerminalMirrorSize => ({
  cols: Math.max(1, Math.floor(cols)),
  rows: Math.max(1, Math.floor(rows)),
})

// Strips CSI escape sequences emitted by interactive CLIs (color, cursor moves,
// etc.) before exposing a single line of scrollback to JSON consumers. Built
// from a String so the regex source does not embed a literal control character
// (lint/suspicious/noControlCharactersInRegex would otherwise flag the file).
const ANSI_CSI_PATTERN = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;?]*[a-zA-Z]`, 'g')

type MouseEncoding = 'DEFAULT' | 'SGR' | 'SGR_PIXELS'

// SerializeAddon records mouse tracking mode but not the SGR/SGR-pixels
// encoding choice. Append it to restored snapshots so reconnecting clients do
// not receive raw mouse escape sequences after a terminal has been recovered.
const mouseEncodingSuffix = (encoding: MouseEncoding) => {
  if (encoding === 'SGR') return '\x1b[?1006h'
  if (encoding === 'SGR_PIXELS') return '\x1b[?1016h'
  return ''
}

export class TerminalStateMirror {
  private readonly serializeAddon = new SerializeAddon()
  private readonly terminal: InstanceType<typeof Terminal>
  private readonly parserDisposables: Array<{ dispose: () => void }> = []
  private mouseEncoding: MouseEncoding = 'DEFAULT'
  private operationQueue: Promise<void> = Promise.resolve()
  private pendingWriteChunks: string[] | undefined
  private disposed = false
  private lastPtyLineCache: string | null = null
  private lastPtyLineDirty = true

  constructor(size: TerminalMirrorSize = { cols: 80, rows: 24 }) {
    const normalized = normalizeTerminalSize(size)
    this.terminal = new Terminal({
      allowProposedApi: true,
      cols: normalized.cols,
      rows: normalized.rows,
      scrollback: TERMINAL_SCROLLBACK,
    })
    this.terminal.loadAddon(this.serializeAddon)
    this.registerMouseEncodingObservers()
  }

  private registerMouseEncodingObservers() {
    // Observe the same public parser that drives headless xterm. Handlers must
    // return false so native DECSET/DECRST/RIS processing continues.
    const applyDecPrivate = (params: Iterable<unknown>, enable: boolean) => {
      for (const param of params) {
        // xterm exposes CSI subparams as array entries but DECSET/DECRST only
        // interprets top-level params. Ignoring arrays keeps this observer in
        // lockstep with the native handler.
        if (typeof param !== 'number' || (param !== 1006 && param !== 1016)) continue
        if (!enable) {
          this.mouseEncoding = 'DEFAULT'
          continue
        }
        this.mouseEncoding = param === 1006 ? 'SGR' : 'SGR_PIXELS'
      }
    }

    this.parserDisposables.push(
      this.terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
        applyDecPrivate(params, true)
        return false
      }),
      this.terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
        applyDecPrivate(params, false)
        return false
      }),
      this.terminal.parser.registerEscHandler({ final: 'c' }, () => {
        this.mouseEncoding = 'DEFAULT'
        return false
      })
    )
  }

  dispose() {
    this.disposed = true
    this.pendingWriteChunks = undefined
    for (const disposable of this.parserDisposables) disposable.dispose()
    this.parserDisposables.length = 0
    this.terminal.dispose()
  }

  getSnapshot() {
    this.pendingWriteChunks = undefined
    // Insert serialization into the queue now. Writes arriving after this call
    // belong only to the live stream, even while xterm is parsing older output.
    const snapshot = this.operationQueue.then(
      () => this.serializeAddon.serialize() + mouseEncodingSuffix(this.mouseEncoding)
    )
    this.operationQueue = snapshot.then(() => undefined)
    return snapshot
  }

  getScreenText(): Promise<string> {
    this.pendingWriteChunks = undefined
    const screen = this.operationQueue.then(() => {
      const buffer = this.terminal.buffer.active
      const lines: string[] = []
      for (let row = buffer.baseY; row < buffer.baseY + this.terminal.rows; row += 1) {
        const line = buffer.getLine(row)
        const text = line?.translateToString(true) ?? ''
        if (line?.isWrapped && lines.length > 0) lines[lines.length - 1] += text
        else lines.push(text)
      }
      return lines.join('\n')
    })
    this.operationQueue = screen.then(() => undefined)
    return screen
  }

  /**
   * Returns the most recent non-empty scrollback line (trimmed, ANSI-stripped,
   * truncated to `maxLen`). Returns `null` when scrollback has no printable
   * content, so the wire protocol can express "no output yet" as a null.
   *
   * The team-list endpoint calls this twice per second per worker, so the
   * buffer scan is cached and only recomputed after new output was written.
   */
  lastPtyLine(maxLen = 60): string | null {
    if (!this.lastPtyLineDirty) {
      return this.lastPtyLineCache === null ? null : this.lastPtyLineCache.slice(0, maxLen)
    }
    const buffer = this.terminal.buffer.active
    let result: string | null = null
    for (let row = buffer.length - 1; row >= 0; row -= 1) {
      const raw = buffer.getLine(row)?.translateToString(true) ?? ''
      const cleaned = raw.replace(ANSI_CSI_PATTERN, '').trim()
      if (cleaned.length === 0) continue
      result = cleaned
      break
    }
    this.lastPtyLineCache = result
    this.lastPtyLineDirty = false
    return result === null ? null : result.slice(0, maxLen)
  }

  resize(cols: number, rows: number) {
    this.pendingWriteChunks = undefined
    const normalized = normalizeTerminalSize({ cols, rows })
    this.operationQueue = this.operationQueue
      .catch(() => undefined)
      .then(() => {
        this.terminal.resize(normalized.cols, normalized.rows)
      })
  }

  /**
   * Keep queued writes appendable until their parser turn starts. Native PTY
   * output arrives in separate event-loop turns; batching only within one
   * microtask still gives every chunk its own xterm write timer and allows
   * the screen to fall many seconds behind the live terminal. Reads and
   * resizes seal the batch so later output cannot cross those boundaries.
   */
  write(chunk: string) {
    if (this.disposed) return
    this.lastPtyLineDirty = true
    if (this.pendingWriteChunks) {
      this.pendingWriteChunks.push(chunk)
      return
    }
    const chunks = [chunk]
    this.pendingWriteChunks = chunks
    this.operationQueue = this.operationQueue
      .then(() => {
        if (this.pendingWriteChunks === chunks) this.pendingWriteChunks = undefined
        if (this.disposed) return
        const data = chunks.join('')
        chunks.length = 0
        return new Promise<void>((resolve) => this.terminal.write(data, () => resolve()))
      })
      .then(() => {
        // The buffer just advanced past anything lastPtyLine may have cached
        // while this batch was still queued.
        this.lastPtyLineDirty = true
      })
  }
}
