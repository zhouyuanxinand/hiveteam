import { delimiter, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AgentSummary, WorkspaceSummary } from '../shared/types.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { AgentSessionStorePort } from './agent-runtime-ports.js'
import { prepareAgentSessionRecovery } from './agent-session-recovery.js'
import {
  buildAgentLegacyIdentityMarker,
  buildAgentSessionBindingMarker,
} from './agent-startup-instructions.js'
import type { CommandPresetRecord } from './command-preset-store.js'
import { withPresetResumeArgs } from './preset-launch-support.js'
import {
  captureSessionIdForCapture,
  getSessionCaptureEnvironment,
  type SessionCaptureSnapshot,
} from './session-capture.js'

const resolveHiveBinDir = () => {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const packageRoot = resolve(moduleDir, '../..')
  return moduleDir.includes(`${sep}dist${sep}src${sep}`)
    ? resolve(packageRoot, 'bin')
    : resolve(packageRoot, 'dist/bin')
}

const HIVE_BIN_DIR = resolveHiveBinDir()
const SESSION_CAPTURE_INTERVAL_MS = 1000

type LaunchPreset = Pick<
  CommandPresetRecord,
  'resumeArgsTemplate' | 'sessionIdCapture' | 'yoloArgsTemplate'
>

const resolveLaunchPreset = (
  config: AgentLaunchConfigInput,
  getCommandPreset: (id: string) => CommandPresetRecord | undefined
): LaunchPreset | undefined => {
  if (config.presetAugmentationDisabled) return undefined
  if (config.commandPresetId) return getCommandPreset(config.commandPresetId)

  const implicitPreset = getCommandPreset(config.command)
  if (!implicitPreset || implicitPreset.command !== config.command) return undefined

  return {
    resumeArgsTemplate: null,
    sessionIdCapture: null,
    yoloArgsTemplate: implicitPreset.yoloArgsTemplate,
  }
}

const createSessionCaptureDiscriminator = (
  workspace: WorkspaceSummary,
  agent: AgentSummary | undefined,
  includeLegacyIdentity = false
) => {
  if (!agent) return undefined
  const contentIncludes = [buildAgentSessionBindingMarker({ agent, workspace })]
  if (includeLegacyIdentity) {
    contentIncludes.push(
      buildAgentLegacyIdentityMarker({
        agent,
        ...(workspace.language ? { language: workspace.language } : {}),
        workspace,
      })
    )
  }
  return {
    contentIncludes,
  }
}

export const buildAgentRunBootstrap = (
  workspace: WorkspaceSummary,
  agentId: string,
  config: AgentLaunchConfigInput,
  sessionStore: AgentSessionStorePort,
  getCommandPreset: (id: string) => CommandPresetRecord | undefined,
  agent?: AgentSummary
) => {
  const preset = resolveLaunchPreset(config, getCommandPreset)
  const capture = config.sessionIdCapture ?? preset?.sessionIdCapture
  const discriminator = createSessionCaptureDiscriminator(workspace, agent)
  const recovery = prepareAgentSessionRecovery({
    agentId,
    capture,
    cwd: workspace.path,
    discriminator,
    sessionStore,
    workspaceId: workspace.id,
  })
  const startConfig = withPresetResumeArgs(
    recovery.capture ? { ...config, sessionIdCapture: recovery.capture } : config,
    preset,
    sessionStore.getLastSessionId(workspace.id, agentId),
    workspace.path,
    createSessionCaptureDiscriminator(
      workspace,
      agent,
      capture?.source === 'claude_project_jsonl_dir'
    )
  )
  const sessionCaptureSnapshot = startConfig.resumedSessionId ? undefined : recovery.snapshot
  return {
    commitSessionContext: () => recovery.commitContext?.(),
    sessionCaptureSnapshot,
    startConfig,
    startEnv: {
      ...getSessionCaptureEnvironment(recovery.snapshot),
      HIVE_PORT: '',
      HIVE_PROJECT_ID: workspace.id,
      HIVE_AGENT_ID: agentId,
      HIVE_AGENT_TOKEN: '',
      PATH: `${HIVE_BIN_DIR}${delimiter}${process.env.PATH ?? ''}`,
    },
  }
}

export const startAgentRunCapture = ({
  agentId,
  sessionCaptureSnapshot,
  sessionStore,
  startConfig,
  workspace,
}: {
  agentId: string
  sessionCaptureSnapshot: SessionCaptureSnapshot | undefined
  sessionStore: AgentSessionStorePort
  startConfig: AgentLaunchConfigInput
  workspace: WorkspaceSummary
}) => {
  const controller = new AbortController()
  if (!sessionCaptureSnapshot || !startConfig.sessionIdCapture) return () => {}
  void captureSessionIdForCapture(
    workspace.path,
    startConfig.sessionIdCapture,
    sessionCaptureSnapshot,
    (sessionId) => {
      sessionStore.setLastSessionId(workspace.id, agentId, sessionId)
    },
    null,
    SESSION_CAPTURE_INTERVAL_MS,
    controller.signal
  ).catch((error: unknown) => {
    console.error(`[hive] session capture failed for ${agentId}`, error)
  })
  return () => controller.abort()
}
