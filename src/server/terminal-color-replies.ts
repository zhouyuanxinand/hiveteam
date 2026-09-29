import type { RuntimeStore } from './runtime-store.js'
import { isTerminalReplyOnly } from './terminal-input-classification.js'

// Codex 0.159.0 ends its paired OSC 10/11 probe after 250 ms. Leave 50 ms
// for the PTY input pipe; a missed optional color probe uses native defaults.
// https://github.com/openai/codex/blob/rust-v0.159.0/codex-rs/tui/src/terminal_probe.rs
const CODEX_COLOR_REPLY_WINDOW_MS = 200
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal OSC query grammar.
const COLOR_QUERY = /\u001b\](10|11);\?(?:\u0007|\u001b\\)/gu
const COLOR_REPLY =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal OSC reply grammar.
  /\u001b\](10|11);rgb:[\da-fA-F]{1,4}\/[\da-fA-F]{1,4}\/[\da-fA-F]{1,4}(?:\u0007|\u001b\\)/gu

/** A native Codex probe has one consumer even when several xterm viewers
 * observe its query. Extra or late replies become literal composer text in
 * Windows Codex. Only live queries may admit a single matching color reply. */
export const createCodexColorReplyBroker = () => {
  const pending = new Map<string, number>()
  let queryTail = ''
  return {
    observeOutput(chunk: string) {
      const previousLength = queryTail.length
      const text = queryTail + chunk
      COLOR_QUERY.lastIndex = 0
      for (const match of text.matchAll(COLOR_QUERY)) {
        if (match.index + match[0].length <= previousLength) continue
        pending.set(match[1] ?? '', Date.now() + CODEX_COLOR_REPLY_WINDOW_MS)
      }
      // An incomplete OSC 10/11 query is at most seven characters.
      queryTail = text.slice(-7)
    },
    filter(input: Buffer | string): Buffer | string {
      const text = Buffer.isBuffer(input) ? input.toString('latin1') : input
      // A paste or mixed user edit remains byte-for-byte user input. Never
      // remove strings from a draft merely because they resemble a reply.
      if (!isTerminalReplyOnly(text)) return input
      COLOR_REPLY.lastIndex = 0
      const filtered = text.replace(COLOR_REPLY, (reply, color: string) => {
        const deadline = pending.get(color)
        pending.delete(color)
        return deadline !== undefined && Date.now() < deadline ? reply : ''
      })
      return Buffer.isBuffer(input) ? Buffer.from(filtered, 'latin1') : filtered
    },
  }
}

export const createTerminalColorReplies = (store: RuntimeStore, runId: string) => {
  const run = store.getLiveRun(runId)
  for (const workspace of store.listWorkspaces()) {
    if (!store.getWorkspaceSnapshot(workspace.id).agents.some((agent) => agent.id === run.agentId))
      continue
    const config = store.peekAgentLaunchConfig(workspace.id, run.agentId)
    const executable = (config?.interactiveCommand ?? config?.command ?? '').split(/[\\/]/u).at(-1)
    if (
      config?.commandPresetId === 'codex' ||
      config?.sessionIdCapture?.source === 'codex_session_jsonl_dir' ||
      /^codex(?:\.(?:cmd|exe|js|ps1))?$/iu.test(executable ?? '')
    )
      return createCodexColorReplyBroker()
  }
  return null
}
