import type { AgentManager } from './agent-manager.js'
import { normalizeExecutableToken } from './startup-command-parser.js'

const INTERACTIVE_COMMANDS = new Set(['claude', 'codex', 'gemini', 'opencode'])
const READY_CHECK_INTERVAL_MS = 50
const MIN_SUBMIT_AFTER_PASTE_DELAY_MS = 600
const MAX_SUBMIT_AFTER_PASTE_DELAY_MS = 1500
const PASTE_CHARS_PER_DELAY_MS = 4
const PASTE_ACK_CHECK_INTERVAL_MS = 50
const PASTE_ACK_SETTLE_DELAY_MS = 100
const PASTE_ACK_TIMEOUT_MS = 3000
const CODEX_STARTUP_PROMPT_SETTLE_DELAY_MS = 1000
const OPENCODE_COMPLETED_TURN_FOOTER_SETTLE_DELAY_MS = 1000
const COMMANDS_WITH_BRACKETED_PASTE = new Set(['claude', 'codex', 'opencode'])
// biome-ignore lint/complexity/useRegexLiterals: build the ANSI matcher from escaped text to avoid literal control characters.
const ANSI_CONTROL_SEQUENCE = new RegExp(
  '\\u001b(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\u0007]*(?:\\u0007|\\u001b\\\\))',
  'gu'
)

interface CodexBootstrapState {
  directoryTrustHandled: boolean
  hooksPromptHandled: boolean
  openCodeCompletionFooter: string | null
  openCodeCompletionFooterSince: number | null
  outputBaseline: number | null
  promptReadySince: number | null
  settled: boolean
  waitingForOutput: boolean
}

const createCodexBootstrapState = (): CodexBootstrapState => ({
  directoryTrustHandled: false,
  hooksPromptHandled: false,
  openCodeCompletionFooter: null,
  openCodeCompletionFooterSince: null,
  outputBaseline: null,
  promptReadySince: null,
  settled: false,
  waitingForOutput: false,
})

export const toBracketedPasteSubmission = (text: string) => `\u001b[200~${text}\u001b[201~`

const getSubmitAfterPasteDelayMs = (text: string) =>
  Math.min(
    MAX_SUBMIT_AFTER_PASTE_DELAY_MS,
    Math.max(MIN_SUBMIT_AFTER_PASTE_DELAY_MS, Math.ceil(text.length / PASTE_CHARS_PER_DELAY_MS))
  )

export const isInteractiveAgentCommand = (command: string) =>
  INTERACTIVE_COMMANDS.has(normalizeExecutableToken(command) ?? '')

const getCommandName = (command: string) => normalizeExecutableToken(command) ?? ''

const getCodexPromptOutput = (output: string, state: CodexBootstrapState) =>
  state.outputBaseline === null ? output : output.slice(state.outputBaseline)

const hasCodexDirectoryTrustPrompt = (output: string) =>
  output.includes('Do you trust the contents of this directory?') &&
  output.includes('Press enter to continue')

const hasCodexHooksReviewPrompt = (output: string) =>
  output.includes('Hooks need review') &&
  output.includes("Continue without trusting (hooks won't run)")

/**
 * Codex can render its normal input line before asynchronously showing its
 * first-run directory and hook trust screens. Handle those screens before
 * treating a `›` line as a prompt, otherwise the Hive bootstrap message is
 * written into the confirmation menu and the orchestrator never reaches its
 * usable prompt.
 */
const handleCodexBootstrapPrompt = (
  agentManager: AgentManager,
  runId: string,
  command: string,
  output: string,
  state: CodexBootstrapState
) => {
  if (getCommandName(command) !== 'codex') return false

  if (state.waitingForOutput) {
    if (state.outputBaseline !== null && output.length <= state.outputBaseline) return true
    state.waitingForOutput = false
  }

  const normalizedOutput = output.replace(ANSI_CONTROL_SEQUENCE, '')
  if (!state.directoryTrustHandled && hasCodexDirectoryTrustPrompt(normalizedOutput)) {
    state.directoryTrustHandled = true
    state.outputBaseline = output.length
    state.promptReadySince = null
    state.settled = false
    state.waitingForOutput = true
    writeIfRunWritable(agentManager, runId, '\r')
    return true
  }

  if (!state.hooksPromptHandled && hasCodexHooksReviewPrompt(normalizedOutput)) {
    state.hooksPromptHandled = true
    state.outputBaseline = output.length
    state.promptReadySince = null
    state.settled = false
    state.waitingForOutput = true
    // Do not auto-trust project hooks. Select "Continue without trusting".
    writeIfRunWritable(agentManager, runId, '\u001b[B\u001b[B\r')
    return true
  }

  return false
}

const isCodexPromptStillSettling = (
  command: string,
  promptReady: boolean,
  state: CodexBootstrapState
) => {
  if (getCommandName(command) !== 'codex' || state.settled) return false
  if (!promptReady) {
    state.promptReadySince = null
    return true
  }
  const now = Date.now()
  state.promptReadySince ??= now
  if (now - state.promptReadySince < CODEX_STARTUP_PROMPT_SETTLE_DELAY_MS) return true
  state.settled = true
  return false
}

const hasGeminiPromptReady = (output: string) => /\bType your message\b/u.test(output)

const OPENCODE_VISIBLE_PROMPT_PATTERN = /\bAsk anything\.\.\./u
const OPENCODE_COMPLETED_TURN_FOOTER_PATTERN = /^▣\s+[^·\n]+·\s+\S.*\s+·\s+\d+(?:\.\d+)?(?:ms|s)$/u
const OPENCODE_INTERRUPT_STATUS_PATTERN = /\besc\s+interrupt\b/iu

const getRecentNonEmptyTerminalLines = (output: string) =>
  output
    .replace(ANSI_CONTROL_SEQUENCE, '')
    .replaceAll('\r', '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

const getOpenCodePromptReadyState = (output: string) => {
  const recentLines = getRecentNonEmptyTerminalLines(output)
  for (let index = recentLines.length - 1; index >= 0; index -= 1) {
    const line = recentLines[index]
    if (line === undefined) continue
    if (
      OPENCODE_INTERRUPT_STATUS_PATTERN.test(line) ||
      OPENCODE_VISIBLE_PROMPT_PATTERN.test(line)
    ) {
      return { marker: line, state: 'ready' as const }
    }
    if (OPENCODE_COMPLETED_TURN_FOOTER_PATTERN.test(line)) {
      return { marker: line, state: 'ready-after-settle' as const }
    }
  }
  return { marker: null, state: 'not-ready' as const }
}

/**
 * OpenCode sometimes finishes rendering a turn with its compact `▣ … · … ·
 * 12ms` footer before it draws the visible composer. Treat that footer as a
 * prompt-ready signal, but wait for one stable second so the Hive envelope is
 * not pasted into a still-updating TUI frame.
 */
const isOpenCodePromptStillSettling = (
  command: string,
  output: string,
  state: CodexBootstrapState
) => {
  if (getCommandName(command) !== 'opencode') return false

  const promptState = getOpenCodePromptReadyState(output)
  if (promptState.state !== 'ready-after-settle' || promptState.marker === null) {
    state.openCodeCompletionFooter = null
    state.openCodeCompletionFooterSince = null
    return false
  }

  const now = Date.now()
  if (state.openCodeCompletionFooter !== promptState.marker) {
    state.openCodeCompletionFooter = promptState.marker
    state.openCodeCompletionFooterSince = now
    return true
  }

  state.openCodeCompletionFooterSince ??= now
  return now - state.openCodeCompletionFooterSince < OPENCODE_COMPLETED_TURN_FOOTER_SETTLE_DELAY_MS
}

export const hasInteractivePromptReady = (output: string, command = '') => {
  const commandName = getCommandName(command)
  const normalizedOutput = output.replace(ANSI_CONTROL_SEQUENCE, '')
  return (
    /(?:^|[\r\n])\s*[❯›]\s*/u.test(normalizedOutput) ||
    (commandName === 'opencode' &&
      getOpenCodePromptReadyState(normalizedOutput).state !== 'not-ready') ||
    (commandName === 'gemini' && hasGeminiPromptReady(normalizedOutput))
  )
}

export const hasBracketedPasteAcknowledgement = (output: string, baselineLength: number) =>
  /\[Pasted text #\d+/u.test(output.slice(baselineLength))

const isClaudeCommand = (command: string) => getCommandName(command) === 'claude'
const usesBracketedPaste = (command: string) =>
  COMMANDS_WITH_BRACKETED_PASTE.has(getCommandName(command))
const isWritableRunStatus = (status: string | undefined) =>
  status === undefined || status === 'starting' || status === 'running'

const createRunInactiveError = (runId: string) =>
  new Error(`Run became inactive before input was submitted: ${runId}`)

const writeIfRunWritable = (agentManager: AgentManager, runId: string, text: string) => {
  let run: ReturnType<AgentManager['getRun']>
  try {
    run = agentManager.getRun(runId)
  } catch {
    return false
  }
  if (!isWritableRunStatus(run.status)) return false
  agentManager.writeInput(runId, text)
  return true
}

const submitPastedInteractiveInput = (
  agentManager: AgentManager,
  runId: string,
  text: string,
  baselineLength: number,
  waitForPasteAck: boolean
) => {
  const pastedAt = Date.now()
  const minDelay = getSubmitAfterPasteDelayMs(text)
  let acknowledgedAt: number | null = null

  const getWritableOutput = () => {
    try {
      const run = agentManager.getRun(runId)
      return isWritableRunStatus(run.status) ? run.output : null
    } catch {
      return null
    }
  }

  const submit = () => {
    try {
      writeIfRunWritable(agentManager, runId, '\r')
    } catch {
      // The PTY may have exited between paste and submit.
    }
  }

  const trySubmit = () => {
    if (!waitForPasteAck) {
      submit()
      return
    }

    const output = getWritableOutput()
    if (output === null) {
      return
    }
    if (acknowledgedAt === null && hasBracketedPasteAcknowledgement(output, baselineLength)) {
      acknowledgedAt = Date.now()
    }

    const elapsed = Date.now() - pastedAt
    // The PTY can buffer the paste before the child process observes it. For
    // bracketed-paste CLIs, start the minimum submit delay at the
    // acknowledgement instead of at pty.write(); otherwise Windows WinPTY
    // can deliver the final Enter before the CLI has finished accepting the
    // pasted payload.
    const submitDelayElapsed =
      Date.now() - (acknowledgedAt === null ? pastedAt : acknowledgedAt) >= minDelay
    const ackSettled =
      acknowledgedAt !== null && Date.now() - acknowledgedAt >= PASTE_ACK_SETTLE_DELAY_MS
    if ((ackSettled && submitDelayElapsed) || elapsed >= PASTE_ACK_TIMEOUT_MS) {
      submit()
      return
    }
    setTimeout(trySubmit, PASTE_ACK_CHECK_INTERVAL_MS)
  }

  // Start watching for the acknowledgement immediately. The submit delay is
  // measured from the acknowledgement once it arrives; waiting minDelay
  // before the first observation would add a second minDelay to every
  // acknowledged paste on WinPTY.
  setTimeout(trySubmit, waitForPasteAck ? PASTE_ACK_CHECK_INTERVAL_MS : minDelay)
}

/**
 * The regular post-start writer intentionally has fire-and-forget semantics:
 * startup guidance should never keep an agent launch pending. Report outbox
 * delivery needs a stronger signal, though, so it can retain an entry until
 * the paste and final Enter were both accepted by the live PTY.
 */
const submitPastedInteractiveInputAwaitable = (
  agentManager: AgentManager,
  runId: string,
  text: string,
  baselineLength: number,
  waitForPasteAck: boolean
) =>
  new Promise<void>((resolve, reject) => {
    const pastedAt = Date.now()
    const minDelay = getSubmitAfterPasteDelayMs(text)
    let acknowledgedAt: number | null = null

    const getWritableOutput = () => {
      try {
        const run = agentManager.getRun(runId)
        return isWritableRunStatus(run.status) ? run.output : null
      } catch {
        return null
      }
    }

    const submit = () => {
      try {
        if (!writeIfRunWritable(agentManager, runId, '\r')) {
          reject(createRunInactiveError(runId))
          return
        }
        resolve()
      } catch (error) {
        reject(error)
      }
    }

    const trySubmit = () => {
      if (!waitForPasteAck) {
        submit()
        return
      }

      const output = getWritableOutput()
      if (output === null) {
        reject(createRunInactiveError(runId))
        return
      }
      if (acknowledgedAt === null && hasBracketedPasteAcknowledgement(output, baselineLength)) {
        acknowledgedAt = Date.now()
      }

      const elapsed = Date.now() - pastedAt
      const submitDelayElapsed =
        Date.now() - (acknowledgedAt === null ? pastedAt : acknowledgedAt) >= minDelay
      const ackSettled =
        acknowledgedAt !== null && Date.now() - acknowledgedAt >= PASTE_ACK_SETTLE_DELAY_MS
      if ((ackSettled && submitDelayElapsed) || elapsed >= PASTE_ACK_TIMEOUT_MS) {
        submit()
        return
      }
      setTimeout(trySubmit, PASTE_ACK_CHECK_INTERVAL_MS)
    }

    // Start watching for the acknowledgement immediately. The submit delay is
    // measured from the acknowledgement once it arrives; waiting minDelay
    // before the first observation would add a second minDelay to every
    // acknowledged paste on WinPTY.
    setTimeout(trySubmit, waitForPasteAck ? PASTE_ACK_CHECK_INTERVAL_MS : minDelay)
  })

export const createAwaitablePostStartInputWriter = (
  agentManager: AgentManager,
  command: string
): ((runId: string, text: string) => Promise<void>) => {
  if (!isInteractiveAgentCommand(command)) {
    return (runId, text) => {
      if (text.trim().length === 0) return Promise.resolve()
      try {
        if (!writeIfRunWritable(agentManager, runId, `${text}\r`)) {
          return Promise.reject(createRunInactiveError(runId))
        }
        return Promise.resolve()
      } catch (error) {
        return Promise.reject(error)
      }
    }
  }

  const codexBootstrapStates = new Map<string, CodexBootstrapState>()

  return (runId, text) => {
    if (text.trim().length === 0) return Promise.resolve()
    const codexBootstrapState = codexBootstrapStates.get(runId) ?? createCodexBootstrapState()
    codexBootstrapStates.set(runId, codexBootstrapState)
    return new Promise<void>((resolve, reject) => {
      const tryWrite = () => {
        let output: string | null
        try {
          const run = agentManager.getRun(runId)
          output = isWritableRunStatus(run.status) ? run.output : null
        } catch (error) {
          reject(error)
          return
        }
        if (output === null) {
          reject(createRunInactiveError(runId))
          return
        }
        try {
          if (
            handleCodexBootstrapPrompt(agentManager, runId, command, output, codexBootstrapState)
          ) {
            setTimeout(tryWrite, READY_CHECK_INTERVAL_MS)
            return
          }
        } catch (error) {
          reject(error)
          return
        }
        // Interactive CLIs can stop here for first-run trust, login, consent,
        // or update prompts. Never use a timer fallback: injecting the Hive
        // contract into one of those screens corrupts onboarding and can make
        // the process look hung. The writer keeps polling until the CLI shows
        // its actual input prompt or the PTY exits.
        const promptReady = hasInteractivePromptReady(
          getCodexPromptOutput(output, codexBootstrapState),
          command
        )
        if (
          isCodexPromptStillSettling(command, promptReady, codexBootstrapState) ||
          isOpenCodePromptStillSettling(command, output, codexBootstrapState)
        ) {
          setTimeout(tryWrite, READY_CHECK_INTERVAL_MS)
          return
        }
        if (promptReady) {
          const baselineLength = output.length
          const input = usesBracketedPaste(command) ? toBracketedPasteSubmission(text) : text
          try {
            if (!writeIfRunWritable(agentManager, runId, input)) {
              reject(createRunInactiveError(runId))
              return
            }
          } catch (error) {
            reject(error)
            return
          }
          submitPastedInteractiveInputAwaitable(
            agentManager,
            runId,
            text,
            baselineLength,
            isClaudeCommand(command)
          ).then(resolve, reject)
          return
        }
        setTimeout(tryWrite, READY_CHECK_INTERVAL_MS)
      }

      tryWrite()
    })
  }
}

export const createPostStartInputWriter = (
  agentManager: AgentManager,
  command: string
): ((runId: string, text: string) => void) => {
  if (!isInteractiveAgentCommand(command)) {
    return (runId, text) => {
      if (text.trim().length === 0) return
      writeIfRunWritable(agentManager, runId, `${text}\r`)
    }
  }

  const codexBootstrapStates = new Map<string, CodexBootstrapState>()

  return (runId, text) => {
    if (text.trim().length === 0) return
    const codexBootstrapState = codexBootstrapStates.get(runId) ?? createCodexBootstrapState()
    codexBootstrapStates.set(runId, codexBootstrapState)
    let isInitialAttempt = true
    const tryWrite = () => {
      let output: string | null
      try {
        const run = agentManager.getRun(runId)
        output = isWritableRunStatus(run.status) ? run.output : null
      } catch {
        return
      }
      if (output === null) return
      try {
        if (handleCodexBootstrapPrompt(agentManager, runId, command, output, codexBootstrapState)) {
          setTimeout(tryWrite, READY_CHECK_INTERVAL_MS)
          return
        }
      } catch (error) {
        if (isInitialAttempt) throw error
        return
      }
      // Do not fall back to a blind timer here. A first-run trust/login prompt
      // is user input, not a ready-to-receive agent prompt.
      const promptReady = hasInteractivePromptReady(
        getCodexPromptOutput(output, codexBootstrapState),
        command
      )
      if (
        isCodexPromptStillSettling(command, promptReady, codexBootstrapState) ||
        isOpenCodePromptStillSettling(command, output, codexBootstrapState)
      ) {
        setTimeout(tryWrite, READY_CHECK_INTERVAL_MS)
        return
      }
      if (promptReady) {
        const baselineLength = output.length
        const input = usesBracketedPaste(command) ? toBracketedPasteSubmission(text) : text
        try {
          if (!writeIfRunWritable(agentManager, runId, input)) return
        } catch (error) {
          if (isInitialAttempt) throw error
          return
        }
        submitPastedInteractiveInput(
          agentManager,
          runId,
          text,
          baselineLength,
          isClaudeCommand(command)
        )
        return
      }
      setTimeout(tryWrite, READY_CHECK_INTERVAL_MS)
    }
    try {
      tryWrite()
    } finally {
      isInitialAttempt = false
    }
  }
}
