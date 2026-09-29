import { createHash, randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { EXECUTION_POLICY_REVISION } from '../shared/execution-policy.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import { createAppStateStore } from './app-state-store.js'
import type { CommandPresetRecord } from './command-preset-store.js'
import type { ExecutionCliIdentity } from './execution-cli-identity.js'
import { supportsModelSelection } from './model-arguments.js'
import type { Database } from './sqlite.js'

const keyFor = (presetId: string) => `execution:automatic-worker-trust:${presetId}`
const modelIndependentArgs = (command: string, args: string[]) => {
  if (!supportsModelSelection(command)) return args
  const codex =
    basename(command)
      .replace(/\.(?:cmd|exe)$/iu, '')
      .toLowerCase() === 'codex'
  const result: string[] = []
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === '--model' || (codex && argument === '-m')) {
      index++
      continue
    }
    if (argument?.startsWith('--model=')) continue
    if (argument !== undefined) result.push(argument)
  }
  return result
}

// A remembered choice follows an installation, not a working directory. Only the
// existing AI CLI model selector may vary; commands, flags and preset env stay pinned.
export const automaticTrustFingerprint = (
  config: AgentLaunchConfigInput,
  identity: ExecutionCliIdentity,
  preset: CommandPresetRecord | undefined
): string | null => {
  if (
    !identity.available ||
    !identity.artifactFingerprint ||
    !preset ||
    config.commandPresetId !== preset.id ||
    config.presetAugmentationDisabled
  )
    return null
  return createHash('sha256')
    .update(
      JSON.stringify({
        artifact: identity.artifactFingerprint,
        preset: {
          id: preset.id,
          command: preset.command,
          args: modelIndependentArgs(preset.command, preset.args),
          env: Object.entries(preset.env).sort(([left], [right]) => left.localeCompare(right)),
          resume: preset.resumeArgsTemplate,
          capture: preset.sessionIdCapture,
          yolo: preset.yoloArgsTemplate ?? [],
        },
        launch: {
          command: config.command,
          args: modelIndependentArgs(config.command, config.args ?? []),
          interactive: config.interactiveCommand ?? null,
          resume: config.resumeArgsTemplate ?? null,
          capture: config.sessionIdCapture ?? null,
        },
        revision: EXECUTION_POLICY_REVISION,
      })
    )
    .digest('hex')
}

export const createAutomaticWorkerTrustStore = (db: Database) => {
  const state = createAppStateStore(db)
  return {
    configured(presetId: string | null | undefined) {
      return Boolean(presetId && state.get(keyFor(presetId)))
    },
    matches(presetId: string | null | undefined, fingerprint: string | null) {
      return Boolean(presetId && fingerprint && state.get(keyFor(presetId))?.value === fingerprint)
    },
    set(workspaceId: string, agentId: string, presetId: string, fingerprint: string | null) {
      db.transaction(() => {
        state.set(keyFor(presetId), fingerprint)
        db.prepare('INSERT INTO execution_policy_events VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          randomUUID(),
          workspaceId,
          agentId,
          'local_user',
          'trust_automatic_workers',
          JSON.stringify({
            preset_id: presetId,
            enabled: fingerprint !== null,
            preference_fingerprint: fingerprint,
            policy_revision: EXECUTION_POLICY_REVISION,
          }),
          Date.now()
        )
      })()
    },
  }
}
