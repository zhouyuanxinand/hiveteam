import { isExternalGoalReportStatus } from './external-goal-store.js'
import { BadRequestError } from './http-errors.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { authenticateCliAgent, requireCommandForRole } from './team-authz.js'

const BODY_MAX_CHARS = 40_000

const requireNonEmptyString = (value: unknown, field: string, maxChars = BODY_MAX_CHARS) => {
  if (typeof value !== 'string' || !value.trim()) throw new BadRequestError(`Missing ${field}`)
  if ([...value].length > maxChars) {
    throw new BadRequestError(`${field} must be ${maxChars} characters or fewer`)
  }
  return value.trim()
}

const getArtifacts = (value: unknown) =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 50)
    : []

/** The authenticated in-workspace command used by an Orchestrator to report an external goal. */
export const teamGoalRoutes: RouteDefinition[] = [
  route('POST', '/api/team/goal/report', async ({ request, response, store }) => {
    const body = await readJsonBody<Record<string, unknown>>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id', 200)
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id', 200)
    const goalId = requireNonEmptyString(body.goal_id, 'goal_id', 200)
    const result = requireNonEmptyString(body.result, 'result')
    if (!isExternalGoalReportStatus(body.status)) {
      throw new BadRequestError('Invalid status; expected progress, done, blocked, or failed')
    }
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: typeof body.token === 'string' ? body.token : undefined,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'goal_report')
    const report = store.reportExternalGoal({
      artifacts: getArtifacts(body.artifacts),
      body: result,
      fromAgentId,
      goalId,
      status: body.status,
      workspaceId: projectId,
    })
    sendJson(response, 202, {
      cursor: report.cursor,
      event: {
        artifacts: report.event.artifacts,
        body: report.event.body,
        created_at: report.event.createdAt,
        goal_id: report.event.goalId,
        id: report.event.id,
        kind: report.event.kind,
        sequence: report.event.sequence,
        status: report.event.status,
        workspace_id: report.event.workspaceId,
      },
      goal_id: goalId,
      ok: true,
      status: report.status,
    })
  }),
]
