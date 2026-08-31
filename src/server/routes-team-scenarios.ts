import { getTeamScenario, TEAM_SCENARIOS } from '../shared/team-scenarios.js'
import { resolveCommandPath } from './agent-command-resolver.js'
import { resolveCommandPresetLaunchConfig } from './agent-launch-resolver.js'
import { ConflictError } from './http-errors.js'
import { autostartAgent } from './orchestrator-autostart.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { buildScenarioWorkerName } from './scenario-worker-name.js'
import { enrichTeamList } from './team-list-enrichment.js'
import { serializeTeamListItem } from './team-list-serializer.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

type TeamScenarioBody = {
  autostart?: unknown
  command_preset_id?: unknown
}

const getRuntimePort = (request: Parameters<RouteDefinition['handler']>[0]['request']) =>
  String(request.socket.localPort ?? '')

const serializeScenario = (scenario: (typeof TEAM_SCENARIOS)[number]) => ({
  description: scenario.description,
  id: scenario.id,
  members: scenario.members,
  name: scenario.name,
})

const installHint = (displayName: string, command: string) =>
  `Install the standalone ${displayName} CLI, then add "${command}" to PATH or bind its executable path in the member dialog.`

export const teamScenarioRoutes: RouteDefinition[] = [
  route('GET', '/api/ui/team-scenarios', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    sendJson(response, 200, {
      scenarios: TEAM_SCENARIOS.map(serializeScenario),
      presets: store.settings.listCommandPresets().map((preset) => {
        let available = false
        try {
          available = Boolean(
            preset.command.trim() &&
              resolveCommandPath(preset.command, process.cwd(), { ...process.env, ...preset.env })
          )
        } catch {
          available = false
        }
        return {
          available,
          display_name: preset.displayName,
          id: preset.id,
          install_hint: installHint(preset.displayName, preset.command),
        }
      }),
    })
  }),
  route(
    'POST',
    '/api/ui/workspaces/:workspaceId/team-scenarios/:scenarioId',
    async ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      const scenarioId = getRequiredParam(response, params, 'scenarioId', 'Scenario id is required')
      if (!workspaceId || !scenarioId) return
      requireUiTokenFromRequest(request, store.validateUiToken)
      const scenario = getTeamScenario(scenarioId)
      if (!scenario) {
        sendJson(response, 404, { error: `Team scenario not found: ${scenarioId}` })
        return
      }

      const body = await readJsonBody<TeamScenarioBody>(request)
      const requestedPreset =
        typeof body.command_preset_id === 'string' && body.command_preset_id.trim()
          ? body.command_preset_id.trim()
          : 'codex'
      const preset = store.settings.getCommandPreset(requestedPreset)
      if (!preset) {
        sendJson(response, 400, { error: `Command preset not found: ${requestedPreset}` })
        return
      }

      let available = false
      try {
        available = Boolean(
          preset.command.trim() &&
            resolveCommandPath(
              preset.command,
              store.getWorkspaceSnapshot(workspaceId).summary.path,
              {
                ...process.env,
                ...preset.env,
              }
            )
        )
      } catch {
        available = false
      }
      if (!available) {
        sendJson(response, 409, {
          error: `${preset.displayName} CLI is not available on PATH`,
          missing: [
            {
              command: preset.command,
              display_name: preset.displayName,
              id: preset.id,
              install_hint: installHint(preset.displayName, preset.command),
            },
          ],
        })
        return
      }

      const launchConfig = resolveCommandPresetLaunchConfig(store.settings, preset.id)
      if (!launchConfig) throw new ConflictError(`Command preset not found: ${preset.id}`)
      const createdIds: string[] = []
      const created: string[] = []
      const reused: string[] = []
      const usedNames = new Set(
        store
          .getWorkspaceSnapshot(workspaceId)
          .agents.filter((agent) => agent.role !== 'orchestrator')
          .map((agent) => agent.name)
      )
      const started: Array<{
        error: string | null
        id: string
        ok: boolean
        run_id: string | null
      }> = []
      try {
        for (const member of scenario.members) {
          const existing = store
            .getWorkspaceSnapshot(workspaceId)
            .agents.find(
              (agent) =>
                agent.role !== 'orchestrator' &&
                agent.role === member.role &&
                (agent.name === member.name || agent.description === member.description)
            )
          if (existing) {
            reused.push(existing.id)
            continue
          }
          const name = buildScenarioWorkerName(member, usedNames)
          usedNames.add(name)
          const worker = store.addWorker(workspaceId, {
            description: member.description,
            name,
            role: member.role,
          })
          createdIds.push(worker.id)
          created.push(worker.id)
          store.configureAgentLaunch(workspaceId, worker.id, launchConfig)
          if (body.autostart !== false) {
            const result = await autostartAgent(
              store,
              workspaceId,
              worker.id,
              getRuntimePort(request),
              {
                missingConfigError: 'No worker launch config available',
              }
            )
            started.push({
              error: result.error,
              id: worker.id,
              ok: result.ok,
              run_id: result.run_id,
            })
          }
        }
      } catch (error) {
        for (const workerId of createdIds) {
          try {
            store.deleteWorker(workspaceId, workerId)
          } catch {
            // Keep the original scenario error; cleanup is best effort.
          }
        }
        throw error
      }

      sendJson(response, 201, {
        command_preset_id: preset.id,
        created,
        reused,
        scenario: serializeScenario(scenario),
        started,
        workers: enrichTeamList(workspaceId, store, store.listWorkers(workspaceId)).map(
          serializeTeamListItem
        ),
      })
    }
  ),
]
