import { randomUUID } from 'node:crypto'

import type { Database } from 'better-sqlite3'

import type {
  SkillChangeAttemptState,
  SkillChangeOperation,
  SkillChangePlan,
  SkillChangeReceipt,
} from '../shared/skill-packs.js'
import type { InternalSkillChangePlan, SkillChangeJournal } from './skill-pack-change-types.js'
import { SkillPackChangeError } from './skill-pack-operation-errors.js'

interface PlanRow {
  action: InternalSkillChangePlan['action']
  applied_attempt_id: string | null
  before_fingerprint: string
  created_at: number
  expires_at: number
  id: string
  intent_json: string
  internal_state_json: string
  operations_json: string
  workspace_id: string
}

interface AttemptRow {
  attempt_rowid: number
  completed_at: number | null
  error: string | null
  id: string
  journal_json: string
  operations_json: string
  plan_id: string
  started_at: number
  state: SkillChangeAttemptState
  workspace_id: string
}

export interface SkillPlacementRecord {
  adapterId: string
  afterFingerprint: string
  attemptId: string
  beforeFingerprint: string
  canonicalTargetPath: string
  createdAt: number
  expectedLinkTarget: string
  id: string
  releaseId: string
  removedAt: number | null
  skillName: string
  state: 'active' | 'removed' | 'drifted'
  workspaceId: string
}

interface PlacementRow {
  adapter_id: string
  after_fingerprint: string
  attempt_id: string
  before_fingerprint: string
  canonical_target_path: string
  created_at: number
  expected_link_target: string
  id: string
  release_id: string
  removed_at: number | null
  skill_name: string
  state: SkillPlacementRecord['state']
  workspace_id: string
}

const planFromRow = (row: PlanRow): InternalSkillChangePlan => {
  const internal = JSON.parse(row.internal_state_json) as Pick<
    InternalSkillChangePlan,
    'internalOperations' | 'observedFiles' | 'observedLinks'
  >
  return {
    action: row.action,
    beforeFingerprint: row.before_fingerprint,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    id: row.id,
    intent: JSON.parse(row.intent_json) as InternalSkillChangePlan['intent'],
    internalOperations: internal.internalOperations,
    observedFiles: internal.observedFiles,
    observedLinks: internal.observedLinks,
    operations: JSON.parse(row.operations_json) as SkillChangeOperation[],
    workspaceId: row.workspace_id,
  }
}

const publicPlanFromRow = (row: PlanRow, now = Date.now()): SkillChangePlan => {
  const plan = planFromRow(row)
  return {
    action: plan.action,
    beforeFingerprint: plan.beforeFingerprint,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    id: plan.id,
    intent: plan.intent,
    operations: plan.operations,
    status: row.applied_attempt_id ? 'applied' : row.expires_at <= now ? 'expired' : 'ready',
    workspaceId: plan.workspaceId,
  }
}

const receiptFromRow = (row: AttemptRow, undoAvailable = false): SkillChangeReceipt => ({
  completedAt: row.completed_at,
  error: row.error,
  id: row.id,
  operations: JSON.parse(row.operations_json) as SkillChangeOperation[],
  planId: row.plan_id,
  startedAt: row.started_at,
  state: row.state,
  undoAvailable,
  workspaceId: row.workspace_id,
})

const placementFromRow = (row: PlacementRow): SkillPlacementRecord => ({
  adapterId: row.adapter_id,
  afterFingerprint: row.after_fingerprint,
  attemptId: row.attempt_id,
  beforeFingerprint: row.before_fingerprint,
  canonicalTargetPath: row.canonical_target_path,
  createdAt: row.created_at,
  expectedLinkTarget: row.expected_link_target,
  id: row.id,
  releaseId: row.release_id,
  removedAt: row.removed_at,
  skillName: row.skill_name,
  state: row.state,
  workspaceId: row.workspace_id,
})

const journalFromJson = (raw: string): SkillChangeJournal => {
  const parsed = JSON.parse(raw) as Partial<SkillChangeJournal>
  if (
    !Array.isArray(parsed.completedOperationIndexes) ||
    parsed.completedOperationIndexes.some((index) => !Number.isInteger(index) || index < 0) ||
    (parsed.direction !== 'apply' && parsed.direction !== 'undo') ||
    (parsed.pendingOperationIndex !== undefined &&
      parsed.pendingOperationIndex !== null &&
      (!Number.isInteger(parsed.pendingOperationIndex) || parsed.pendingOperationIndex < 0))
  ) {
    throw new Error('Persisted Skill Pack change journal is invalid')
  }
  return {
    completedOperationIndexes: [...new Set(parsed.completedOperationIndexes)],
    direction: parsed.direction,
    pendingOperationIndex: parsed.pendingOperationIndex ?? null,
  }
}

const SELECT_PLAN = `SELECT id, workspace_id, action, intent_json, operations_json,
                            internal_state_json, before_fingerprint, created_at,
                            expires_at, applied_attempt_id
                       FROM skill_change_plans`

const SELECT_ATTEMPT = `SELECT a.rowid AS attempt_rowid,
                               a.id, a.workspace_id, a.plan_id, a.state,
                               a.journal_json, a.error, a.started_at, a.completed_at,
                               p.operations_json
                          FROM skill_change_attempts a
                          JOIN skill_change_plans p ON p.id = a.plan_id`

const SELECT_PLACEMENT = `SELECT id, workspace_id, release_id, attempt_id, adapter_id,
                                 skill_name, canonical_target_path, expected_link_target,
                                 before_fingerprint, after_fingerprint, state,
                                 created_at, removed_at
                            FROM skill_placements`

export const createSkillPackChangeStore = (db: Database) => {
  const savePlan = (
    input: Omit<InternalSkillChangePlan, 'createdAt' | 'expiresAt' | 'id'>,
    ttlMs = 15 * 60_000
  ): InternalSkillChangePlan => {
    const createdAt = Date.now()
    const plan: InternalSkillChangePlan = {
      ...input,
      createdAt,
      expiresAt: createdAt + ttlMs,
      id: randomUUID(),
    }
    db.prepare(
      `INSERT INTO skill_change_plans (
         id, workspace_id, action, intent_json, operations_json,
         internal_state_json, before_fingerprint, created_at, expires_at,
         applied_attempt_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    ).run(
      plan.id,
      plan.workspaceId,
      plan.action,
      JSON.stringify(plan.intent),
      JSON.stringify(plan.operations),
      JSON.stringify({
        internalOperations: plan.internalOperations,
        observedFiles: plan.observedFiles,
        observedLinks: plan.observedLinks,
      }),
      plan.beforeFingerprint,
      plan.createdAt,
      plan.expiresAt
    )
    return plan
  }

  const getPlan = (workspaceId: string, planId: string): InternalSkillChangePlan | null => {
    const row = db
      .prepare(`${SELECT_PLAN} WHERE id = ? AND workspace_id = ?`)
      .get(planId, workspaceId) as PlanRow | undefined
    return row ? planFromRow(row) : null
  }

  const listPlans = (workspaceId: string, limit = 20): SkillChangePlan[] =>
    (
      db
        .prepare(`${SELECT_PLAN} WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`)
        .all(workspaceId, limit) as PlanRow[]
    ).map((row) => publicPlanFromRow(row))

  const beginAttempt = (plan: InternalSkillChangePlan) => {
    const attemptId = randomUUID()
    const startedAt = Date.now()
    const journal: SkillChangeJournal = {
      completedOperationIndexes: [],
      direction: 'apply',
      pendingOperationIndex: null,
    }
    db.transaction(() => {
      const active = db
        .prepare(
          `SELECT id FROM skill_change_attempts
           WHERE workspace_id = ? AND state IN ('applying', 'recovery_required') LIMIT 1`
        )
        .get(plan.workspaceId) as { id: string } | undefined
      if (active) {
        throw new SkillPackChangeError(
          'recovery_required',
          'An unfinished Skill Pack change must be recovered first'
        )
      }
      db.prepare(
        `INSERT INTO skill_change_attempts (
           id, workspace_id, plan_id, state, journal_json, error,
           started_at, completed_at
         ) VALUES (?, ?, ?, 'applying', ?, NULL, ?, NULL)`
      ).run(attemptId, plan.workspaceId, plan.id, JSON.stringify(journal), startedAt)
    })()
    return { attemptId, journal, startedAt }
  }

  const updateJournal = (attemptId: string, journal: SkillChangeJournal) => {
    const result = db
      .prepare(
        `UPDATE skill_change_attempts SET journal_json = ?
       WHERE id = ? AND state IN ('applying', 'recovery_required')`
      )
      .run(JSON.stringify(journal), attemptId)
    if (result.changes !== 1) throw new Error('Skill Pack change journal is not writable')
  }

  const beginUndo = (workspaceId: string, attemptId: string) => {
    const journal: SkillChangeJournal = {
      completedOperationIndexes: [],
      direction: 'undo',
      pendingOperationIndex: null,
    }
    db.transaction(() => {
      const active = db
        .prepare(
          `SELECT id FROM skill_change_attempts
           WHERE workspace_id = ? AND state IN ('applying', 'recovery_required') LIMIT 1`
        )
        .get(workspaceId) as { id: string } | undefined
      if (active) {
        throw new SkillPackChangeError(
          'recovery_required',
          'An unfinished Skill Pack change must be recovered first'
        )
      }
      const result = db
        .prepare(
          `UPDATE skill_change_attempts
           SET state = 'applying', journal_json = ?, error = NULL, completed_at = NULL
           WHERE id = ? AND workspace_id = ? AND state = 'applied'`
        )
        .run(JSON.stringify(journal), attemptId, workspaceId)
      if (result.changes !== 1) {
        throw new SkillPackChangeError(
          'receipt_not_undoable',
          'This Change Receipt is not eligible for Undo'
        )
      }
    })()
    return journal
  }

  const finishAttempt = (
    attemptId: string,
    state: Exclude<SkillChangeAttemptState, 'applying'>,
    error: string | null
  ) => {
    db.prepare(
      `UPDATE skill_change_attempts
       SET state = ?, error = ?, completed_at = ?
       WHERE id = ?`
    ).run(state, error, Date.now(), attemptId)
  }

  const markPlanApplied = (planId: string, attemptId: string) => {
    const result = db
      .prepare(
        `UPDATE skill_change_plans SET applied_attempt_id = ?
         WHERE id = ? AND applied_attempt_id IS NULL`
      )
      .run(attemptId, planId)
    if (result.changes !== 1) throw new Error('skill_plan_already_applied')
  }

  const hasAppliedAttempt = (planId: string) => {
    const row = db
      .prepare('SELECT applied_attempt_id FROM skill_change_plans WHERE id = ?')
      .get(planId) as { applied_attempt_id: string | null } | undefined
    return Boolean(row?.applied_attempt_id)
  }

  const hasIncompleteAttempt = (workspaceId: string) =>
    Boolean(
      db
        .prepare(
          `SELECT id FROM skill_change_attempts
           WHERE workspace_id = ? AND state IN ('applying', 'recovery_required') LIMIT 1`
        )
        .get(workspaceId)
    )

  const getReceipt = (workspaceId: string, attemptId: string): SkillChangeReceipt | null => {
    const row = db
      .prepare(`${SELECT_ATTEMPT} WHERE a.id = ? AND a.workspace_id = ?`)
      .get(attemptId, workspaceId) as AttemptRow | undefined
    if (!row) return null
    const newerApplied = db
      .prepare(
        `SELECT id FROM skill_change_attempts
         WHERE workspace_id = ? AND state = 'applied' AND rowid > ? LIMIT 1`
      )
      .get(workspaceId, row.attempt_rowid)
    return receiptFromRow(
      row,
      row.state === 'applied' && !newerApplied && !hasIncompleteAttempt(workspaceId)
    )
  }

  const getAttemptJournal = (attemptId: string): SkillChangeJournal | null => {
    const row = db
      .prepare('SELECT journal_json FROM skill_change_attempts WHERE id = ?')
      .get(attemptId) as { journal_json: string } | undefined
    return row ? journalFromJson(row.journal_json) : null
  }

  const listReceipts = (workspaceId: string, limit = 20): SkillChangeReceipt[] => {
    const rows = db
      .prepare(
        `${SELECT_ATTEMPT}
         WHERE a.workspace_id = ?
         ORDER BY a.started_at DESC, a.rowid DESC LIMIT ?`
      )
      .all(workspaceId, limit) as AttemptRow[]
    let undoBlocked = false
    return rows.map((row) => {
      if (row.state === 'applying' || row.state === 'recovery_required') undoBlocked = true
      const receipt = receiptFromRow(row, row.state === 'applied' && !undoBlocked)
      if (row.state === 'applied') undoBlocked = true
      return receipt
    })
  }

  const listIncompleteAttempts = () =>
    (
      db
        .prepare(
          `${SELECT_ATTEMPT}
         WHERE a.state IN ('applying', 'recovery_required')
         ORDER BY a.started_at ASC`
        )
        .all() as AttemptRow[]
    ).map((row) => ({
      journal: journalFromJson(row.journal_json),
      plan: getPlan(row.workspace_id, row.plan_id),
      receipt: receiptFromRow(row),
    }))

  const listActivePlacements = (workspaceId: string): SkillPlacementRecord[] =>
    (
      db
        .prepare(
          `${SELECT_PLACEMENT}
           WHERE workspace_id = ? AND state = 'active'
           ORDER BY canonical_target_path ASC`
        )
        .all(workspaceId) as PlacementRow[]
    ).map(placementFromRow)

  const recordPlacementCreated = (input: {
    afterFingerprint: string
    attemptId: string
    beforeFingerprint: string
    canonicalTargetPath: string
    expectedLinkTarget: string
    releaseId: string
    skillName: string
    workspaceId: string
  }) => {
    db.prepare(
      `INSERT INTO skill_placements (
         id, workspace_id, release_id, attempt_id, adapter_id, skill_name,
         canonical_target_path, expected_link_target, before_fingerprint,
         after_fingerprint, state, created_at, removed_at
       ) VALUES (?, ?, ?, ?, 'codex-native-v1', ?, ?, ?, ?, ?, 'active', ?, NULL)`
    ).run(
      randomUUID(),
      input.workspaceId,
      input.releaseId,
      input.attemptId,
      input.skillName,
      input.canonicalTargetPath,
      input.expectedLinkTarget,
      input.beforeFingerprint,
      input.afterFingerprint,
      Date.now()
    )
  }

  const markPlacementRemoved = (
    workspaceId: string,
    canonicalTargetPath: string,
    attemptId: string
  ) => {
    const result = db
      .prepare(
        `UPDATE skill_placements
         SET state = 'removed', removed_at = ?, attempt_id = ?
         WHERE workspace_id = ? AND canonical_target_path = ? AND state = 'active'`
      )
      .run(Date.now(), attemptId, workspaceId, canonicalTargetPath)
    if (result.changes !== 1) throw new Error('active_skill_placement_not_found')
  }

  const restorePlacement = (
    workspaceId: string,
    canonicalTargetPath: string,
    attemptId: string,
    releaseId: string,
    expectedLinkTarget: string
  ) => {
    const result = db
      .prepare(
        `UPDATE skill_placements
         SET state = 'active', removed_at = NULL, attempt_id = ?
         WHERE id = (
           SELECT id FROM skill_placements
           WHERE workspace_id = ?
             AND canonical_target_path = ?
             AND release_id = ?
             AND expected_link_target = ?
             AND state = 'removed'
           ORDER BY created_at DESC LIMIT 1
         )`
      )
      .run(attemptId, workspaceId, canonicalTargetPath, releaseId, expectedLinkTarget)
    if (result.changes !== 1) throw new Error('removed_skill_placement_not_found')
  }

  const markPlacementDrifted = (workspaceId: string, canonicalTargetPath: string) => {
    db.prepare(
      `UPDATE skill_placements SET state = 'drifted'
       WHERE workspace_id = ? AND canonical_target_path = ? AND state = 'active'`
    ).run(workspaceId, canonicalTargetPath)
  }

  const commitApply = (
    plan: InternalSkillChangePlan,
    attemptId: string,
    placementOperations: Array<
      Extract<InternalSkillChangePlan['internalOperations'][number], { kind: 'placement' }>
    >
  ) => {
    db.transaction(() => {
      for (const operation of placementOperations) {
        if (operation.publicKind === 'remove_placement') {
          markPlacementRemoved(plan.workspaceId, operation.path, attemptId)
        } else {
          recordPlacementCreated({
            afterFingerprint: operation.after.fingerprint,
            attemptId,
            beforeFingerprint: operation.before.fingerprint,
            canonicalTargetPath: operation.path,
            expectedLinkTarget: operation.after.target ?? '',
            releaseId: operation.releaseId,
            skillName: operation.skillName,
            workspaceId: plan.workspaceId,
          })
        }
      }
      markPlanApplied(plan.id, attemptId)
      finishAttempt(attemptId, 'applied', null)
    })()
  }

  const commitUndo = (
    plan: InternalSkillChangePlan,
    attemptId: string,
    placementOperations: Array<
      Extract<InternalSkillChangePlan['internalOperations'][number], { kind: 'placement' }>
    >
  ) => {
    db.transaction(() => {
      for (const operation of [...placementOperations].reverse()) {
        if (operation.publicKind === 'create_placement') {
          markPlacementRemoved(plan.workspaceId, operation.path, attemptId)
        } else {
          restorePlacement(
            plan.workspaceId,
            operation.path,
            attemptId,
            operation.releaseId,
            operation.before.target ?? ''
          )
        }
      }
      finishAttempt(attemptId, 'rolled_back', null)
    })()
  }

  const deleteWorkspace = (workspaceId: string) => {
    db.transaction(() => {
      db.prepare('DELETE FROM skill_placements WHERE workspace_id = ?').run(workspaceId)
      db.prepare('DELETE FROM skill_change_attempts WHERE workspace_id = ?').run(workspaceId)
      db.prepare('DELETE FROM skill_change_plans WHERE workspace_id = ?').run(workspaceId)
    })()
  }

  return {
    beginAttempt,
    beginUndo,
    commitApply,
    commitUndo,
    deleteWorkspace,
    finishAttempt,
    getAttemptJournal,
    getPlan,
    getReceipt,
    hasAppliedAttempt,
    hasIncompleteAttempt,
    listActivePlacements,
    listIncompleteAttempts,
    listPlans,
    listReceipts,
    markPlacementDrifted,
    markPlacementRemoved,
    markPlanApplied,
    recordPlacementCreated,
    restorePlacement,
    savePlan,
    updateJournal,
  }
}

export type SkillPackChangeStore = ReturnType<typeof createSkillPackChangeStore>
