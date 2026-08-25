import { basename } from 'node:path'

import type { AgentManager } from './agent-manager.js'

const INTERACTIVE_COMMANDS = new Set(['claude', 'codex', 'gemini', 'opencode'])
const READY_CHECK_INTERVAL_MS = 50
const READY_TIMEOUT_MS = 3000
const MIN_SUBMIT_AFTER_PASTE_DELAY_MS = 600
const MAX_SUBMIT_AFTER_PASTE_DELAY_MS = 1500
const PASTE_CHARS_PER_DELAY_MS = 4
const PASTE_ACK_CHECK_INTERVAL_MS = 50
const PASTE_ACK_SETTLE_DELAY_MS = 100
const PASTE_ACK_TIMEOUT_MS = 3000
const COMMANDS_WITH_BRACKETED_PASTE = new Set(['claude', 'codex', 'opencode'])
// biome-ignore lint/complexity/useRegexLiterals: build the ANSI matcher from escaped text to avoid literal control characters.
const ANSI_CONTROL_SEQUENCE = new RegExp(
  '\\u001b(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\u0007]*(?:\\u0007|\\u001b\\\\))',
  'gu'
)

export const toBracketedPasteSubmission = (text: string) => `\u001b[200~${text}\u001b[201~`

const getSubmitAfterPasteDelayMs = (text: string) =>
  Math.min(
    MAX_SUBMIT_AFTER_PASTE_DELAY_MS,
    Math.max(MIN_SUBMIT_AFTER_PASTE_DELAY_MS, Math.ceil(text.length / PASTE_CHARS_PER_DELAY_MS))
  )

export const isInteractiveAgentCommand = (command: string) =>
  INTERACTIVE_COMMANDS.has(basename(command).toLowerCase())

const getCommandName = (command: string) => basename(command).toLowerCase()

const hasGeminiPromptReady = (output: string) => /\bType your message\b/u.test(output)

export const hasInteractivePromptReady = (output: string, command = '') => {
  const commandName = getCommandName(command)
  const normalizedOutput = output.replace(ANSI_CONTROL_SEQUENCE, '')
  return (
    /(?:^|[\r\n])\s*[❯›]\s*/u.test(normalizedOutput) ||
    (commandName === 'gemini' && hasGeminiPromptReady(normalizedOutput))
  )
}

export const hasBracketedPasteAcknowledgement = (output: string, baselineLength: number) =>
  /\[Pasted text #\d+/u.test(output.slice(baselineLength))

const isClaudeCommand = (command: string) => getCommandName(command) === 'claude'
const usesBracketedPaste = (command: string) =>
  COMMANDS_WITH_BRACKETED_PASTE.has(getCommandName(command))
const canTimeoutBeforePromptReady = (command: string) => getCommandName(command) !== 'gemini'
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
    const ackSettled =
      acknowledgedAt !== null && Date.now() - acknowledgedAt >= PASTE_ACK_SETTLE_DELAY_MS
    if ((ackSettled && elapsed >= minDelay) || elapsed >= PASTE_ACK_TIMEOUT_MS) {
      submit()
      return
    }
    setTimeout(trySubmit, PASTE_ACK_CHECK_INTERVAL_MS)
  }

  setTimeout(trySubmit, minDelay)
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
      const ackSettled =
        acknowledgedAt !== null && Date.now() - acknowledgedAt >= PASTE_ACK_SETTLE_DELAY_MS
      if ((ackSettled && elapsed >= minDelay) || elapsed >= PASTE_ACK_TIMEOUT_MS) {
        submit()
        return
      }
      setTimeout(trySubmit, PASTE_ACK_CHECK_INTERVAL_MS)
    }

    setTimeout(trySubmit, minDelay)
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

  return (runId, text) => {
    if (text.trim().length === 0) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const startedAt = Date.now()

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
        if (
          hasInteractivePromptReady(output, command) ||
          (canTimeoutBeforePromptReady(command) && Date.now() - startedAt >= READY_TIMEOUT_MS)
        ) {
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

  return (runId, text) => {
    if (text.trim().length === 0) return
    const startedAt = Date.now()
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
      if (
        hasInteractivePromptReady(output, command) ||
        (canTimeoutBeforePromptReady(command) && Date.now() - startedAt >= READY_TIMEOUT_MS)
      ) {
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
