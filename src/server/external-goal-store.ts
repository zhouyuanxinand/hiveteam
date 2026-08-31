import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'

export const EXTERNAL_GOAL_STATUSES = [
  'open',
  'in_progress',
  'blocked',
  'done',
  'failed',
  'cancelled',
] as const

export const EXTERNAL_GOAL_REPORT_STATUSES = ['progress', 'done', 'blocked', 'failed'] as const

export const EXTERNAL_GOAL_EVENT_KINDS = [
  'goal_started',
  'goal_continued',
  'goal_delivered',
  'progress_reported',
  'goal_done',
  'goal_blocked',
  'goal_failed',
  'goal_cancelled',
  'delivery_failed',
] as const

export type ExternalGoalStatus = (typeof EXTERNAL_GOAL_STATUSES)[number]
export type ExternalGoalReportStatus = (typeof EXTERNAL_GOAL_REPORT_STATUSES)[number]
export type ExternalGoalEventKind = (typeof EXTERNAL_GOAL_EVENT_KINDS)[number]
export type ExternalGoalEventStatus = ExternalGoalReportStatus | ExternalGoalStatus | null

export interface ExternalGoalSession {
  closedAt: number | null
  context: unknown
  createdAt: number
  goal: string
  id: string
  source: string
  status: ExternalGoalStatus
  summary: string | null
  title: string
  updatedAt: number
  workspaceId: string
}

export interface ExternalGoalEvent {
  artifacts: string[]
  body: string
  createdAt: number
  goalId: string
  id: string
  kind: ExternalGoalEventKind
  sequence: number
  status: ExternalGoalEventStatus
  workspaceId: string
}

export interface CreateExternalGoalSessionInput {
  context?: unknown
  goal: string
  source: string
  workspaceId: string
}

export interface AppendExternalGoalEventInput {
  artifacts?: string[]
  body: string
  goalId: string
  kind: ExternalGoalEventKind
  sessionStatus?: ExternalGoalStatus
  status?: ExternalGoalEventStatus
}

interface ExternalGoalSessionRow {
  closed_at: number | null
  context_json: string
  created_at: number
  goal: string
  id: string
  source: string
  status: ExternalGoalStatus
  summary: string | null
  title: string | null
  updated_at: number
  workspace_id: string
}

interface ExternalGoalEventRow {
  artifacts_json: string
  body: string
  created_at: number
  goal_id: string
  id: string
  kind: ExternalGoalEventKind
  sequence: number
  status: ExternalGoalEventStatus
  workspace_id: string
}

const CLOSED_STATUSES = new Set<ExternalGoalStatus>(['blocked', 'done', 'failed', 'cancelled'])

const parseJson = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

const parseArtifacts = (value: string) => {
  const parsed = parseJson<unknown>(value, [])
  return Array.isArray(parsed)
    ? parsed.filter((artifact): artifact is string => typeof artifact === 'string')
    : []
}

const deriveTitle = (goal: string) => {
  const firstLine = goal
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean)
  return (firstLine ?? 'External goal').slice(0, 120)
}

const toSession = (row: ExternalGoalSessionRow): ExternalGoalSession => ({
  closedAt: row.closed_at,
  context: parseJson<unknown>(row.context_json, null),
  createdAt: row.created_at,
  goal: row.goal,
  id: row.id,
  source: row.source,
  status: row.status,
  summary: row.summary,
  title: row.title ?? deriveTitle(row.goal),
  updatedAt: row.updated_at,
  workspaceId: row.workspace_id,
})

const toEvent = (row: ExternalGoalEventRow): ExternalGoalEvent => ({
  artifacts: parseArtifacts(row.artifacts_json),
  body: row.body,
  createdAt: row.created_at,
  goalId: row.goal_id,
  id: row.id,
  kind: row.kind,
  sequence: row.sequence,
  status: row.status,
  workspaceId: row.workspace_id,
})

export const isExternalGoalReportStatus = (value: unknown): value is ExternalGoalReportStatus =>
  typeof value === 'string' && (EXTERNAL_GOAL_REPORT_STATUSES as readonly string[]).includes(value)

export const createExternalGoalStore = (db: Database) => {
  const getSession = (goalId: string) => {
    const row = db.prepare('SELECT * FROM external_goal_sessions WHERE id = ?').get(goalId) as
      | ExternalGoalSessionRow
      | undefined
    return row ? toSession(row) : undefined
  }

  const listEventsAfter = (goalId: string, cursor = 0) =>
    (
      db
        .prepare(
          `SELECT * FROM external_goal_events
           WHERE goal_id = ? AND sequence > ?
           ORDER BY sequence ASC`
        )
        .all(goalId, cursor) as ExternalGoalEventRow[]
    ).map(toEvent)

  const getLatestSequence = (goalId: string) => {
    const row = db
      .prepare(
        'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM external_goal_events WHERE goal_id = ?'
      )
      .get(goalId) as { sequence?: number } | undefined
    return Number(row?.sequence ?? 0)
  }

  const insertEvent = (session: ExternalGoalSession, input: AppendExternalGoalEventInput) => {
    const now = Date.now()
    const event: ExternalGoalEvent = {
      artifacts: input.artifacts ?? [],
      body: input.body,
      createdAt: now,
      goalId: session.id,
      id: randomUUID(),
      kind: input.kind,
      sequence: getLatestSequence(session.id) + 1,
      status: input.status ?? null,
      workspaceId: session.workspaceId,
    }
    db.prepare(
      `INSERT INTO external_goal_events (
         id, goal_id, workspace_id, sequence, kind, status, body, artifacts_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      event.id,
      event.goalId,
      event.workspaceId,
      event.sequence,
      event.kind,
      event.status,
      event.body,
      JSON.stringify(event.artifacts),
      event.createdAt
    )
    if (input.sessionStatus) {
      db.prepare(
        `UPDATE external_goal_sessions
         SET status = ?, updated_at = ?, closed_at = ?
         WHERE id = ?`
      ).run(
        input.sessionStatus,
        now,
        CLOSED_STATUSES.has(input.sessionStatus) ? now : null,
        session.id
      )
    } else {
      db.prepare('UPDATE external_goal_sessions SET updated_at = ? WHERE id = ?').run(
        now,
        session.id
      )
    }
    return event
  }

  const appendEvent = (input: AppendExternalGoalEventInput) =>
    db.transaction(() => {
      const session = getSession(input.goalId)
      if (!session) throw new Error(`External goal not found: ${input.goalId}`)
      return insertEvent(session, input)
    })()

  const createSession = (input: CreateExternalGoalSessionInput) =>
    db.transaction(() => {
      const now = Date.now()
      const session: ExternalGoalSession = {
        closedAt: null,
        context: input.context ?? null,
        createdAt: now,
        goal: input.goal,
        id: `goal_${randomUUID()}`,
        source: input.source,
        status: 'open',
        summary: null,
        title: deriveTitle(input.goal),
        updatedAt: now,
        workspaceId: input.workspaceId,
      }
      db.prepare(
        `INSERT INTO external_goal_sessions (
           id, workspace_id, source, status, goal, context_json, title, summary,
           created_at, updated_at, closed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        session.id,
        session.workspaceId,
        session.source,
        session.status,
        session.goal,
        JSON.stringify(session.context),
        session.title,
        session.summary,
        session.createdAt,
        session.updatedAt,
        session.closedAt
      )
      const event = insertEvent(session, {
        body: session.goal,
        goalId: session.id,
        kind: 'goal_started',
        status: 'open',
      })
      return { event, session }
    })()

  return {
    appendEvent,
    createSession,
    deleteWorkspaceGoals(workspaceId: string) {
      db.prepare('DELETE FROM external_goal_events WHERE workspace_id = ?').run(workspaceId)
      db.prepare('DELETE FROM external_goal_sessions WHERE workspace_id = ?').run(workspaceId)
    },
    getLatestSequence,
    getSession,
    listEventsAfter,
  }
}

export type ExternalGoalStore = ReturnType<typeof createExternalGoalStore>
