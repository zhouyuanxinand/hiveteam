import { getModelSwitchCapability } from './model-switch-capabilities.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type {
  ConfigureAgentLaunchBody,
  OpenModelPickerBody,
  RouteDefinition,
} from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'
import { getWorkspaceShellAgentId } from './workspace-shell-runtime.js'

export const runtimeRoutes: RouteDefinition[] = [
  route('GET', '/api/ui/workspaces/:workspaceId/runs', ({ params, request, response, store }) => {
    const workspaceId = getRequiredParam(
      response,
      params,
      'workspaceId',
      'Workspace id is required'
    )
    if (!workspaceId) {
      return
    }

    requireUiTokenFromRequest(request, store.validateUiToken)

    sendJson(response, 200, store.listTerminalRuns(workspaceId))
  }),
  route(
    'POST',
    '/api/workspaces/:workspaceId/shell/start',
    async ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken)

      const run = await store.startWorkspaceShell(workspaceId)
      const summary = store
        .listTerminalRuns(workspaceId)
        .find((terminalRun) => terminalRun.run_id === run.runId)
      sendJson(response, 201, {
        agent_id: getWorkspaceShellAgentId(workspaceId),
        agent_name: summary?.agent_name ?? 'Shell',
        run_id: run.runId,
        status: run.status,
        terminal_input_profile: summary?.terminal_input_profile ?? 'default',
      })
    }
  ),
  route(
    'DELETE',
    '/api/workspaces/:workspaceId/shell/:runId',
    ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id and run id are required'
      )
      const runId = getRequiredParam(
        response,
        params,
        'runId',
        'Workspace id and run id are required'
      )
      if (!workspaceId || !runId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken)
      if (!store.closeWorkspaceShell(workspaceId, runId)) {
        sendJson(response, 404, { error: 'Shell run not found' })
        return
      }
      response.statusCode = 204
      response.end()
    }
  ),
  route(
    'POST',
    '/api/workspaces/:workspaceId/agents/:agentId/config',
    async ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id and agent id are required'
      )
      const agentId = getRequiredParam(
        response,
        params,
        'agentId',
        'Workspace id and agent id are required'
      )
      if (!workspaceId || !agentId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken)

      const body = await readJsonBody<ConfigureAgentLaunchBody>(request)
      store.configureAgentLaunch(workspaceId, agentId, {
        command: body.command,
        commandPresetId: body.command_preset_id ?? null,
        ...(body.args ? { args: body.args } : {}),
      })
      response.statusCode = 204
      response.end()
    }
  ),
  route('POST', '/api/runtime/runs/:runId/stop', ({ params, request, response, store }) => {
    const runId = getRequiredParam(response, params, 'runId', 'Run id is required')
    if (!runId) {
      return
    }

    requireUiTokenFromRequest(request, store.validateUiToken)

    store.stopAgentRun(runId)
    sendJson(response, 202, { ok: true })
  }),
  route('GET', '/api/runtime/runs/:runId', ({ params, request, response, store }) => {
    const runId = getRequiredParam(response, params, 'runId', 'Run id is required')
    if (!runId) {
      return
    }

    requireUiTokenFromRequest(request, store.validateUiToken)

    sendJson(response, 200, store.getLiveRun(runId))
  }),
  route(
    'POST',
    '/api/runtime/runs/:runId/model-picker',
    async ({ params, request, response, store }) => {
      const runId = getRequiredParam(response, params, 'runId', 'Run id is required')
      if (!runId) return

      requireUiTokenFromRequest(request, store.validateUiToken)
      const body = await readJsonBody<OpenModelPickerBody>(request)
      const presetId = typeof body.command_preset_id === 'string' ? body.command_preset_id : ''
      const preset = store.settings.getCommandPreset(presetId)
      const capability = preset ? getModelSwitchCapability(preset.command) : undefined
      if (!capability) {
        sendJson(response, 409, {
          error: 'This CLI does not expose a documented native model picker.',
        })
        return
      }

      store.getLiveRun(runId)
      store.writeRunInput(runId, capability.input)
      sendJson(response, 200, {
        command: capability.pickerCommand,
        strategy: capability.strategy,
      })
    }
  ),
]
