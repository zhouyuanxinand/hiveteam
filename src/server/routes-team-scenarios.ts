import type {
  ScenarioLaunchEvent,
  ScenarioLaunchMember,
  ScenarioStartResult,
} from '../shared/team-scenario-launch.js'
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
      const created: string[] = []
      const reused: string[] = []
      const usedNames = new Set(
        store
          .getWorkspaceSnapshot(workspaceId)
          .agents.filter((agent) => agent.role !== 'orchestrator')
          .map((agent) => agent.name)
      )
      const started: ScenarioStartResult[] = []
      const members: ScenarioLaunchMember[] = []
      const additions: Array<{
        description: string
        name: string
        role: (typeof scenario.members)[number]['role']
      }> = []
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
          members.push({
            id: existing.id,
            name: existing.name,
            role: member.role,
            state: 'reused',
            error: null,
            duration_ms: null,
          })
          continue
        }
        const name = buildScenarioWorkerName(member, usedNames)
        usedNames.add(name)
        additions.push({
          description: member.description,
          name,
          role: member.role,
        })
      }
      const workers = store.addWorkers(workspaceId, additions, launchConfig)
      for (const worker of workers) {
        created.push(worker.id)
        members.push({
          id: worker.id,
          name: worker.name,
          role: worker.role as ScenarioLaunchMember['role'],
          state: body.autostart === false ? 'created' : 'queued',
          error: null,
          duration_ms: null,
        })
      }

      // JSON remains the default contract. The UI opts into progress on this
      // same request; disconnecting the view does not cancel persisted members.
      const streaming = request.headers.accept === 'application/x-ndjson'
      const emit = (event: ScenarioLaunchEvent) => {
        if (streaming && !response.destroyed && !response.writableEnded)
          response.write(`${JSON.stringify(event)}\n`)
      }
      if (streaming) {
        response.writeHead(201, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-store',
        })
        emit({ type: 'progress', members })
      }
      try {
        const queue = members.filter((member) => member.state === 'queued')
        const launchNext = async () => {
          for (let member = queue.shift(); member; member = queue.shift()) {
            member.state = 'starting'
            emit({ type: 'progress', members })
            const begin = performance.now()
            const result = await autostartAgent(
              store,
              workspaceId,
              member.id,
              getRuntimePort(request),
              {
                missingConfigError: 'No worker launch config available',
              }
            )
            member.state = result.queue_id ? 'queued' : result.ok ? 'started' : 'failed'
            member.error = result.error
            member.duration_ms = Math.round(performance.now() - begin)
            started.push({ id: member.id, ...result })
            emit({ type: 'progress', members })
          }
        }
        // Bound CPU/IO contention, while overlapping the independent early-exit
        // observation windows. A failed start does not roll back other members.
        await Promise.all([launchNext(), launchNext()])
        const result = {
          command_preset_id: preset.id,
          created,
          reused,
          scenario: serializeScenario(scenario),
          started: created.flatMap((id) => started.filter((item) => item.id === id)),
          workers: enrichTeamList(workspaceId, store, store.listWorkers(workspaceId)).map(
            serializeTeamListItem
          ),
        }
        if (streaming) {
          emit({ type: 'result', result })
          response.end()
        } else sendJson(response, 201, result)
      } catch (error) {
        if (!streaming) throw error
        // Headers are already sent. Forward the cause on the same stream,
        // rather than attempting a second HTTP response or reporting success.
        emit({ type: 'error', error: error instanceof Error ? error.message : String(error) })
        response.end()
      }
    }
  ),
]
