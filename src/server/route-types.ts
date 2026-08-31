import type { IncomingMessage, ServerResponse } from 'node:http'

import type { WorkerRole, WorkspaceLanguage } from '../shared/types.js'
import type { PickFolderResponse } from './fs-pick-folder.js'
import type {
  OpenCommandResult,
  OpenWorkspaceInput as OpenWorkspaceServiceInput,
} from './open-target-commands.js'
import type { RuntimeStore } from './runtime-store.js'
import type { TasksFileService } from './tasks-file.js'
import type { VersionService } from './version-service.js'

export interface SendTaskBody {
  hive_port?: string
  project_id: string
  from_agent_id: string
  token?: string
  to: string
  text: string
}

export interface ReportTaskBody {
  dispatch_id?: string
  project_id: string
  from_agent_id: string
  token?: string
  result: string
  status?: string
  artifacts?: unknown[]
}

export interface CancelTaskBody {
  dispatch_id?: string
  project_id: string
  from_agent_id: string
  token?: string
  reason?: string
}

export interface CreateWorkspaceBody {
  /** Prompt/protocol language for this workspace. Defaults to Chinese. */
  language?: WorkspaceLanguage
  path: string
  name: string
  /** Default true. When false, skip orchestrator PTY spawn after creation. */
  autostart_orchestrator?: boolean
  /** Optional command preset. With startup_command, this selects the CLI interaction driver. */
  command_preset_id?: string | null
  /** Optional full startup command. When set, it overrides the executable only. */
  startup_command?: string | null
}

export interface CreateWorkerBody {
  autostart?: boolean
  avatar?: string | null
  command_preset_id?: string | null
  description?: string
  /** Optional model id. Built-in CLIs receive it as `--model <id>`. */
  model?: string | null
  name: string
  role: WorkerRole
  /** Optional full startup command. When set, it overrides the executable only. */
  startup_command?: string | null
}

export interface UserInputBody {
  text: string
}

export interface OpenModelPickerBody {
  command_preset_id?: string | null
}

export interface ConfigureAgentLaunchBody {
  command: string
  args?: string[]
  command_preset_id?: string | null
}

export interface OpenWorkspaceBody {
  target_id: string
}

export type OpenWorkspaceService = (input: OpenWorkspaceServiceInput) => Promise<OpenCommandResult>

export interface RouteContext {
  request: IncomingMessage
  response: ServerResponse
  store: RuntimeStore
  tasksFileService: TasksFileService
  pickFolderService: () => Promise<PickFolderResponse>
  openWorkspaceService: OpenWorkspaceService
  versionService: VersionService
  params: Record<string, string>
}

export interface RouteDefinition {
  method: string
  path: string
  handler: (context: RouteContext) => Promise<void> | void
}

export type { WorkerRole }
