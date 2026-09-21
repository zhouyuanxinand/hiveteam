import type { AgentManager } from './agent-manager.js'
import { ConflictError } from './http-errors.js'
import { isInteractiveAgentCommand } from './post-start-input-writer.js'
import type { SystemMessageDeliveryOptions } from './report-delivery-receipt.js'
import { normalizeExecutableToken } from './startup-command-parser.js'
import { TerminalStateMirror } from './terminal-state-mirror.js'

/** Scope the awaitable writer's reads/writes to one attempt; user input invalidates it. */
export const guardDeliveryInput = (
  manager: AgentManager,
  runId: string,
  delivery: NonNullable<SystemMessageDeliveryOptions['delivery']>
) => {
  const deadline = Date.now() + delivery.timeoutMs
  let sequence = manager.getInputSequence(runId)
  const check = () => {
    if (delivery.signal.aborted)
      throw new ConflictError('Delivery stopped; retained its checkpoint')
    if (Date.now() >= deadline) throw new ConflictError('Delivery confirmation deadline reached')
    if (manager.getInputSequence(runId) !== sequence)
      throw new ConflictError(
        'Other terminal input interrupted delivery. Hive will not overwrite or submit your draft. Review the composer before continuing.'
      )
  }
  const guarded: AgentManager = {
    ...manager,
    getRun(id) {
      check()
      return manager.getRun(id)
    },
    writeInput(id, text) {
      check()
      delivery.beforeWrite()
      manager.writeInput(id, text)
      sequence = manager.getInputSequence(runId)
    },
  }
  return guarded
}

export const requireEmptyDeliveryComposer = async (
  manager: AgentManager,
  runId: string,
  command: string
) => {
  if (!isInteractiveAgentCommand(command)) return
  const name = normalizeExecutableToken(command)
  // Codex has its own session-bound receipt adapter. Other screen formats need
  // separately verified empty-composer support rather than Codex regex reuse.
  if (name !== 'claude')
    throw new ConflictError(
      'This CLI has no verified automatic composer adapter. Deliver manually and mark handled.'
    )
  const mirror = new TerminalStateMirror(manager.getTerminalSize(runId))
  try {
    mirror.write(manager.getRun(runId).output)
    const screen = await mirror.getScreenText()
    const lines = screen.split('\n')
    let prompt = lines.length - 1
    while (prompt >= 0 && !/^\s*❯/u.test(lines[prompt] ?? '')) prompt -= 1
    if (prompt < 0 || !/^\s*❯\s*$/u.test(lines[prompt] ?? ''))
      throw new ConflictError('Waiting for an empty Claude composer; existing input is preserved')
  } finally {
    mirror.dispose()
  }
}
