import { randomUUID } from 'node:crypto'
import {
  MEMORY_DREAM_PLAN_VERSION,
  type MemoryDreamChange,
  type MemoryDreamOperation,
  type MemoryDreamReceipt,
  type MemoryDreamSnapshot,
} from '../shared/memory-dream-plan.js'
import type { TeamMemoryDreamRun } from '../shared/team-memory.js'
import { BadRequestError, ConflictError, ForbiddenError } from './http-errors.js'
import { parseDreamOperations, requireDreamRevision } from './memory-dream-input.js'
import {
  dreamHash,
  dreamValuePatch,
  prepareDreamOperations,
  restoreDreamMemory,
  snapshotDreamMemory,
} from './memory-dream-snapshots.js'
import type { Database } from './sqlite.js'
import type { TeamMemoryStore } from './team-memory-store.js'

const requireCurrentPlan = (run: TeamMemoryDreamRun) => {
  if (run.planVersion !== MEMORY_DREAM_PLAN_VERSION)
    throw new ConflictError(
      'This legacy Dream is read-only. Prepare a new Dream to capture source versions.'
    )
}
const requireEditable = (run: TeamMemoryDreamRun, revision: number) => {
  requireCurrentPlan(run)
  if (run.generation && run.generation.status !== 'completed')
    throw new ConflictError('Wait until Dream candidates are ready before editing or applying')
  if (run.status !== 'review')
    throw new ConflictError('Only a Dream in review can be edited or applied')
  if (run.planRevision !== revision)
    throw new ConflictError(
      'The Dream draft changed. Reload it before reviewing and applying again.'
    )
}

/** Owns the complete SQLite transaction for every plan and memory mutation. */
export const createMemoryDreamApply = (
  db: Database,
  memory: TeamMemoryStore,
  get: (workspaceId: string, dreamId: string) => TeamMemoryDreamRun | undefined
) => {
  const liveSnapshot = (workspaceId: string, id: string) => {
    const entry = memory.get(workspaceId, id)
    if (!entry) throw new ConflictError(`Memory ${id} is no longer available. Prepare a new Dream.`)
    return snapshotDreamMemory(memory, workspaceId, entry)
  }
  const requireUnchanged = (workspaceId: string, expected: MemoryDreamSnapshot) => {
    const current = liveSnapshot(workspaceId, expected.memory_id)
    if (current.revision !== expected.revision || current.content_hash !== expected.content_hash) {
      throw new ConflictError(
        `Memory ${expected.memory_id} changed since review. No changes were applied.`
      )
    }
    return current
  }
  const validateSources = (run: TeamMemoryDreamRun, operations: MemoryDreamOperation[]) => {
    const captured = new Map(run.sourceSnapshots.map((source) => [source.memory_id, source]))
    const selected = new Map<string, MemoryDreamSnapshot>()
    for (const operation of operations) {
      const evidence = new Set(
        run.generation?.input.messages.map((message) => message.sequence) ?? []
      )
      if (
        operation.message_sources?.some((sequence) => !evidence.has(sequence)) ||
        (run.generation && operation.action !== 'archive' && !operation.message_sources?.length)
      )
        throw new BadRequestError('Generated operations must cite messages from their frozen input')
      for (const ref of operation.sources) {
        const source = captured.get(ref.memory_id)
        if (
          !source ||
          source.revision !== ref.expected_revision ||
          source.content_hash !== ref.expected_hash
        ) {
          throw new BadRequestError(
            'Operation sources must use the versions captured in this Dream'
          )
        }
        if (!selected.has(source.memory_id))
          selected.set(source.memory_id, requireUnchanged(run.workspaceId, source))
      }
    }
    return selected
  }
  const saveOperations = (run: TeamMemoryDreamRun, operations: MemoryDreamOperation[]) => {
    const revision =
      run.planRevision + (dreamHash(run.operations) === dreamHash(operations) ? 0 : 1)
    db.prepare(`UPDATE memory_dream_runs SET operations_json=?,plan_revision=?,updated_at=?
      WHERE workspace_id=? AND id=?`).run(
      JSON.stringify(operations),
      revision,
      Date.now(),
      run.workspaceId,
      run.id
    )
    return revision
  }
  return {
    create(workspaceId: string) {
      return db
        .transaction(() => {
          const sources = memory
            .list(workspaceId, { limit: 50, status: 'active' })
            .filter(
              (entry) => !entry.disabled && (entry.kind !== 'procedure_ref' || entry.procedureRef)
            )
            .map((entry) => snapshotDreamMemory(memory, workspaceId, entry))
          const operations = parseDreamOperations(prepareDreamOperations(sources))
          const now = Date.now()
          const id = randomUUID()
          db.prepare(`INSERT INTO memory_dream_runs (
          id,workspace_id,status,suggestions_json,source_snapshots_json,created_memory_ids_json,
          created_at,submitted_at,rolled_back_at,updated_at,execution_status,orchestrator_run_id,
          execution_error,plan_version,plan_revision,operations_json,change_receipt_json
        ) VALUES (?,?,'review','[]',?,'[]',?,NULL,NULL,?,'queued',NULL,NULL,?,1,?,NULL)`).run(
            id,
            workspaceId,
            JSON.stringify(sources),
            now,
            now,
            MEMORY_DREAM_PLAN_VERSION,
            JSON.stringify(operations)
          )
          return get(workspaceId, id) as TeamMemoryDreamRun
        })
        .immediate()
    },
    discard(workspaceId: string, dreamId: string, expectedRevision: unknown) {
      return db
        .transaction(() => {
          const run = get(workspaceId, dreamId)
          if (!run) return undefined
          const revision = requireDreamRevision(expectedRevision)
          if (run.status === 'discarded' && run.planRevision === revision) return run
          requireEditable(run, revision)
          db.prepare(
            "UPDATE memory_dream_runs SET status='discarded',execution_status='completed',execution_error=NULL,updated_at=? WHERE workspace_id=? AND id=?"
          ).run(Date.now(), workspaceId, dreamId)
          return get(workspaceId, dreamId)
        })
        .immediate()
    },
    updateOperations(
      workspaceId: string,
      dreamId: string,
      expectedRevision: unknown,
      input: unknown
    ) {
      return db
        .transaction(() => {
          const run = get(workspaceId, dreamId)
          if (!run) return undefined
          requireEditable(run, requireDreamRevision(expectedRevision))
          const operations = parseDreamOperations(input)
          validateSources(run, operations)
          saveOperations(run, operations)
          return get(workspaceId, dreamId)
        })
        .immediate()
    },
    submit(
      workspaceId: string,
      dreamId: string,
      actor: { id: string; name: string },
      expectedRevision: unknown,
      input?: unknown
    ) {
      if (actor.id !== `${workspaceId}:orchestrator`)
        throw new ForbiddenError('Only the Workspace Orchestrator can submit a Dream')
      return db
        .transaction(() => {
          const run = get(workspaceId, dreamId)
          if (!run) return undefined
          requireCurrentPlan(run)
          const revision = requireDreamRevision(expectedRevision)
          const operations = parseDreamOperations(input === undefined ? run.operations : input)
          const requestHash = dreamHash(operations)
          if (
            run.status === 'submitted' &&
            run.receipt?.request_revision === revision &&
            run.receipt.request_hash === requestHash
          )
            return run
          requireEditable(run, revision)
          if (!operations.length)
            throw new BadRequestError('Select at least one operation to apply')
          const sources = validateSources(run, operations)
          const planRevision = saveOperations(run, operations)
          const changes: Array<Omit<MemoryDreamChange, 'after'>> = []
          const createdIds: string[] = []
          for (const operation of operations) {
            if (operation.action !== 'add') {
              for (const ref of operation.sources) {
                const before = sources.get(ref.memory_id)
                if (!before) throw new Error('Validated Dream source is missing')
                const patch =
                  operation.action === 'rewrite' && operation.result
                    ? dreamValuePatch(operation.result)
                    : { status: 'archived' as const }
                memory.update(workspaceId, ref.memory_id, patch)
                changes.push({
                  operation_id: operation.id,
                  action: operation.action,
                  memory_id: ref.memory_id,
                  before,
                })
              }
            }
            if ((operation.action === 'add' || operation.action === 'merge') && operation.result) {
              const created = memory.create(workspaceId, {
                ...dreamValuePatch(operation.result),
                createdByAgentId: actor.id,
                createdByAgentName: actor.name,
                source: 'dream',
                status: 'active',
              })
              if (
                operation.action === 'merge' &&
                operation.sources.some((ref) => sources.get(ref.memory_id)?.pinned)
              ) {
                memory.update(workspaceId, created.id, { pinned: true })
              }
              db.prepare(`UPDATE memory_sources SET source_id=?,source_sequence=?,text_hash=?
              WHERE memory_id=? AND source_type='dream'`).run(
                dreamId,
                planRevision,
                dreamHash({
                  plan_revision: planRevision,
                  operations_json: JSON.stringify(operations),
                }),
                created.id
              )
              createdIds.push(created.id)
              changes.push({
                operation_id: operation.id,
                action: operation.action,
                memory_id: created.id,
                before: null,
              })
            }
          }
          const now = Date.now()
          const receipt: MemoryDreamReceipt = {
            id: randomUUID(),
            dream_id: dreamId,
            plan_revision: planRevision,
            request_revision: revision,
            request_hash: requestHash,
            actor: { ...actor, role: 'orchestrator' },
            applied_at: now,
            rolled_back_at: null,
            sources: [...sources.values()],
            ...(run.generation
              ? {
                  message_evidence: {
                    input_hash: run.generation.input_hash,
                    from: run.generation.input.from,
                    to: run.generation.input.to,
                    messages: run.generation.input.messages,
                    citations: operations.map((operation) => ({
                      operation_id: operation.id,
                      sequences: operation.message_sources ?? [],
                    })),
                  },
                }
              : {}),
            changes: changes.map((change) => ({
              ...change,
              after: liveSnapshot(workspaceId, change.memory_id),
            })),
          }
          db.prepare(`UPDATE memory_dream_runs SET status='submitted',created_memory_ids_json=?,
          submitted_at=?,updated_at=?,execution_status='completed',execution_error=NULL,change_receipt_json=?
          WHERE workspace_id=? AND id=?`).run(
            JSON.stringify(createdIds),
            now,
            now,
            JSON.stringify(receipt),
            workspaceId,
            dreamId
          )
          return get(workspaceId, dreamId)
        })
        .immediate()
    },
    rollback(workspaceId: string, dreamId: string) {
      return db
        .transaction(() => {
          const run = get(workspaceId, dreamId)
          if (!run) return undefined
          requireCurrentPlan(run)
          if (!run.receipt)
            throw new ConflictError('A persisted change receipt is required for rollback')
          if (run.status === 'rolled_back') return run
          if (run.status !== 'submitted')
            throw new ConflictError('Only an applied Dream can be rolled back')
          // Validate the entire post-state before restoring anything; unrelated memories are never read or written.
          for (const change of run.receipt.changes) requireUnchanged(workspaceId, change.after)
          for (const change of run.receipt.changes) {
            memory.update(
              workspaceId,
              change.memory_id,
              change.before
                ? restoreDreamMemory(change.before)
                : { status: 'archived', disabled: true }
            )
          }
          const now = Date.now()
          db.prepare(`UPDATE memory_dream_runs SET status='rolled_back',rolled_back_at=?,updated_at=?,change_receipt_json=?
          WHERE workspace_id=? AND id=?`).run(
            now,
            now,
            JSON.stringify({ ...run.receipt, rolled_back_at: now }),
            workspaceId,
            dreamId
          )
          return get(workspaceId, dreamId)
        })
        .immediate()
    },
  }
}
