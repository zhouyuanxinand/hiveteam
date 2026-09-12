import { BadRequestError } from './http-errors.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type {
  CancelTaskBody,
  LoadSkillBody,
  ReadSkillBody,
  ReportTaskBody,
  RouteDefinition,
  SendTaskBody,
} from './route-types.js'
import { authenticateCliAgent, requireCommandForRole } from './team-authz.js'
import { TeamSkillRuntimeError } from './team-skill-runtime.js'

const requireNonEmptyString = (value: unknown, field: string) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestError(`Missing ${field}`)
  }
  return value
}

const optionalNonEmptyString = (value: unknown, field: string) =>
  value === undefined ? undefined : requireNonEmptyString(value, field)

const getArtifacts = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const sendSkillError = (response: Parameters<typeof sendJson>[0], error: unknown) => {
  if (!(error instanceof TeamSkillRuntimeError)) throw error
  const notFound = new Set(['dispatch_not_found', 'skill_not_found'])
  const conflicts = new Set(['ambiguous_skill', 'cache_drift', 'skill_runtime_unavailable'])
  sendJson(response, notFound.has(error.code) ? 404 : conflicts.has(error.code) ? 409 : 403, {
    error: error.message,
    error_code: error.code,
  })
}

export const teamRoutes: RouteDefinition[] = [
  route('POST', '/api/team/send', async ({ request, response, store }) => {
    const body = await readJsonBody<SendTaskBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const to = requireNonEmptyString(body.to, 'to')
    const text = requireNonEmptyString(body.text, 'text')
    const skillName = optionalNonEmptyString(body.skill_name, 'skill_name')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'send')
    let dispatch: Awaited<ReturnType<typeof store.dispatchTaskByWorkerName>>
    try {
      dispatch = await store.dispatchTaskByWorkerName(projectId, to, text, {
        fromAgentId,
        hivePort: String(request.socket.localPort ?? ''),
        ...(skillName ? { skillName } : {}),
      })
    } catch (error) {
      if (error instanceof TeamSkillRuntimeError) {
        sendSkillError(response, error)
        return
      }
      throw error
    }

    const activation = store.skills.getDispatchActivation(dispatch.id)
    sendJson(response, 202, {
      dispatch_id: dispatch.id,
      ok: true,
      ...(activation
        ? {
            skill: {
              delivery_mode: activation.deliveryMode,
              name: activation.skillName,
              pack_name: activation.packName,
              payload_digest: activation.payloadDigest,
              release_id: activation.releaseId,
            },
          }
        : {}),
    })
  }),
  route('GET', '/api/team/skills', async ({ request, response, store }) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const projectId = requireNonEmptyString(url.searchParams.get('project_id'), 'project_id')
    const fromAgentId = requireNonEmptyString(request.headers['x-hive-agent-id'], 'x-hive-agent-id')
    const token = request.headers['x-hive-agent-token']
    authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: Array.isArray(token) ? token[0] : token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    try {
      const skills = await store.skills.listForAgent(projectId, fromAgentId)
      sendJson(response, 200, {
        skills: skills.map((skill) => ({
          description: skill.description,
          explicit_only: skill.explicitOnly,
          name: skill.name,
          qualified_name: skill.qualifiedName,
          release_id: skill.releaseId,
        })),
      })
    } catch (error) {
      sendSkillError(response, error)
    }
  }),
  route('POST', '/api/team/skills/load', async ({ request, response, store }) => {
    const body = await readJsonBody<LoadSkillBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const dispatchId = optionalNonEmptyString(body.dispatch_id, 'dispatch_id')
    const skillName = optionalNonEmptyString(body.skill_name, 'skill_name')
    if (Boolean(dispatchId) === Boolean(skillName)) {
      throw new BadRequestError('Exactly one of dispatch_id or skill_name is required')
    }
    authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    try {
      const activation = await store.skills.loadForAgent({
        agentId: fromAgentId,
        ...(dispatchId ? { dispatchId } : {}),
        ...(skillName ? { skillName } : {}),
        workspaceId: projectId,
      })
      sendJson(response, 200, {
        delivery_mode: activation.deliveryMode,
        instruction_snapshot: activation.instructionSnapshot,
        pack_name: activation.packName,
        payload_digest: activation.payloadDigest,
        release_id: activation.releaseId,
        skill_digest: activation.skillDigest,
        skill_name: activation.skillName,
      })
    } catch (error) {
      sendSkillError(response, error)
    }
  }),
  route('POST', '/api/team/skills/read', async ({ request, response, store }) => {
    const body = await readJsonBody<ReadSkillBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const dispatchId = requireNonEmptyString(body.dispatch_id, 'dispatch_id')
    const path = requireNonEmptyString(body.path, 'path')
    authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    try {
      const reference = await store.skills.readDispatchReference({
        agentId: fromAgentId,
        dispatchId,
        path,
        workspaceId: projectId,
      })
      sendJson(response, 200, {
        content: reference.content,
        path: reference.path,
        payload_digest: reference.payloadDigest,
      })
    } catch (error) {
      sendSkillError(response, error)
    }
  }),
  route('POST', '/api/team/cancel', async ({ request, response, store }) => {
    const body = await readJsonBody<CancelTaskBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const dispatchId = requireNonEmptyString(body.dispatch_id, 'dispatch_id')
    const reason = requireNonEmptyString(body.reason, 'reason')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'cancel')
    const result = store.cancelTask(projectId, dispatchId, { fromAgentId, reason })
    sendJson(response, 202, {
      dispatch_id: result.dispatch?.id ?? null,
      forward_error: result.forwardError,
      forwarded: result.forwarded,
      ok: true,
    })
  }),
  route('POST', '/api/team/report', async ({ request, response, store }) => {
    const body = await readJsonBody<ReportTaskBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const resultText = requireNonEmptyString(body.result, 'result')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'report')
    const reportInput = {
      artifacts: getArtifacts(body.artifacts),
      ...(typeof body.dispatch_id === 'string' ? { dispatchId: body.dispatch_id } : {}),
      requireActiveRun: true,
      text: resultText,
    }
    if (typeof body.status === 'string') {
      const result = store.reportTask(projectId, fromAgentId, {
        ...reportInput,
        status: body.status,
      })
      sendJson(response, 202, {
        ...(result.deliveryState ? { delivery_state: result.deliveryState } : {}),
        dispatch_id: result.dispatch?.id ?? null,
        forward_error: result.forwardError,
        forwarded: result.forwarded,
        ok: true,
      })
      return
    } else {
      const result = store.reportTask(projectId, fromAgentId, reportInput)
      sendJson(response, 202, {
        ...(result.deliveryState ? { delivery_state: result.deliveryState } : {}),
        dispatch_id: result.dispatch?.id ?? null,
        forward_error: result.forwardError,
        forwarded: result.forwarded,
        ok: true,
      })
      return
    }
  }),
  route('POST', '/api/team/status', async ({ request, response, store }) => {
    const body = await readJsonBody<ReportTaskBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const resultText = requireNonEmptyString(body.result, 'result')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'status')
    const result = store.statusTask(projectId, fromAgentId, {
      artifacts: getArtifacts(body.artifacts),
      requireActiveRun: true,
      text: resultText,
    })
    sendJson(response, 202, {
      dispatch_id: result.dispatch?.id ?? null,
      forward_error: result.forwardError,
      forwarded: result.forwarded,
      ok: true,
    })
    return
  }),
]
