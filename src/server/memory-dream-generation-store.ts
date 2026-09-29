import { randomUUID } from 'node:crypto'
import type { MemoryDreamCursor, MemoryDreamGeneration } from '../shared/memory-dream-generation.js'
import type { MemoryDreamOperation, MemoryDreamSnapshot } from '../shared/memory-dream-plan.js'
import type { TeamMemoryDreamRun } from '../shared/team-memory.js'
import { ConflictError } from './http-errors.js'
import { parseDreamGenerationResult } from './memory-dream-generation-input.js'
import { readDreamGeneration, readDreamGenerationRow } from './memory-dream-generation-reader.js'
import { dreamMessageSourceHash } from './memory-dream-message-window.js'
import { dreamHash, snapshotDreamMemory } from './memory-dream-snapshots.js'
import type { createMessageLogStore } from './message-log-store.js'
import type { Database } from './sqlite.js'
import type { createTeamMemoryDreamStore } from './team-memory-dream-store.js'
import type { TeamMemoryStore } from './team-memory-store.js'

const RETRY_AFTER_MS = 5 * 60 * 1000
export const createMemoryDreamGenerationStore = (
  db: Database,
  memory: TeamMemoryStore,
  dreams: ReturnType<typeof createTeamMemoryDreamStore>,
  messages: ReturnType<typeof createMessageLogStore>
) => {
  const cursor = (workspaceId: string): MemoryDreamCursor => {
    const row = db
      .prepare('SELECT sequence,offset,source_hash FROM memory_dream_cursors WHERE workspace_id=?')
      .get(workspaceId) as MemoryDreamCursor | undefined
    return row ?? { sequence: 0, offset: 0, source_hash: null }
  }
  const requireRun = (workspaceId: string, dreamId: string): TeamMemoryDreamRun => {
    const run = dreams.get(workspaceId, dreamId)
    if (!run?.generation)
      throw new ConflictError('Dream generation was not found in this workspace')
    return run
  }
  const pending = (workspaceId: string) =>
    (
      db
        .prepare(
          "SELECT dream_id FROM memory_dream_generations WHERE workspace_id=? AND status!='completed' ORDER BY created_at"
        )
        .all(workspaceId) as { dream_id: string }[]
    ).map((row) => requireRun(workspaceId, row.dream_id))
  return {
    cursor,
    pending,
    // Called inside the worker-deletion transaction. Frozen candidates stay readable;
    // only the explicitly removed, still-unconsumed message remainder may be skipped.
    recordWorkerMessageDeletion(workspaceId: string, workerId: string) {
      const boundaries = [cursor(workspaceId)]
      for (const run of pending(workspaceId)) {
        if (run.generation) boundaries.push(run.generation.input.from, run.generation.input.to)
      }
      for (const boundary of boundaries) {
        if (boundary.offset <= 0 || !boundary.source_hash) continue
        const row = db
          .prepare('SELECT * FROM messages WHERE workspace_id=? AND worker_id=? AND sequence=?')
          .get(workspaceId, workerId, boundary.sequence) as
          | Parameters<typeof dreamMessageSourceHash>[0]
          | undefined
        if (!row || dreamMessageSourceHash(row) !== boundary.source_hash) continue
        db.prepare(`INSERT INTO memory_dream_deleted_sources(workspace_id,sequence,source_hash,deleted_at) VALUES(?,?,?,?)
          ON CONFLICT(workspace_id,sequence) DO UPDATE SET source_hash=excluded.source_hash,deleted_at=excluded.deleted_at`).run(
          workspaceId,
          boundary.sequence,
          boundary.source_hash,
          Date.now()
        )
      }
    },
    getInput: (workspaceId: string, dreamId: string) =>
      readDreamGeneration(db, workspaceId, dreamId),
    hasPendingEvidence: (workspaceId: string) =>
      messages.hasDreamMessages(workspaceId, cursor(workspaceId)),
    prepare(workspaceId: string): TeamMemoryDreamRun | null {
      return db
        .transaction(() => {
          const existing = pending(workspaceId)[0]
          if (existing) return existing
          // Complete the current human review before making another batch.
          if (dreams.hasReviewDraft(workspaceId))
            throw new ConflictError(
              'Apply or discard the existing Dream draft before generating another batch'
            )
          const window = messages.readDreamWindow(workspaceId, cursor(workspaceId))
          if (!window) return null
          const context: MemoryDreamSnapshot[] = []
          let remaining = 12000
          for (const entry of memory.list(workspaceId, { limit: 50, status: 'active' })) {
            if (entry.disabled || (entry.kind === 'procedure_ref' && !entry.procedureRef)) continue
            const snapshot = snapshotDreamMemory(memory, workspaceId, entry)
            const size = JSON.stringify(snapshot).length
            if (size > remaining) continue
            context.push(snapshot)
            remaining -= size
            if (context.length === 8) break
          }
          const input: MemoryDreamGeneration['input'] = { ...window, memories: context }
          const run = dreams.create(workspaceId)
          const now = Date.now()
          db.prepare(
            "UPDATE memory_dream_runs SET operations_json='[]',source_snapshots_json=? WHERE workspace_id=? AND id=?"
          ).run(JSON.stringify(context), workspaceId, run.id)
          db.prepare(`INSERT INTO memory_dream_generations (dream_id,workspace_id,status,input_json,input_hash,created_at,updated_at)
          VALUES (?,?,'pending',?,?,?,?)`).run(
            run.id,
            workspaceId,
            JSON.stringify(input),
            dreamHash(input),
            now,
            now
          )
          return requireRun(workspaceId, run.id)
        })
        .immediate()
    },
    claim(workspaceId: string, dreamId: string, runId: string, options: { force?: boolean } = {}) {
      return db
        .transaction(() => {
          const row = readDreamGenerationRow(db, workspaceId, dreamId)
          if (!row) throw new ConflictError('Dream generation was not found in this workspace')
          if (row.status === 'completed') return null
          const now = Date.now()
          if (
            !options.force &&
            row.run_id === runId &&
            row.requested_at !== null &&
            now - row.requested_at < RETRY_AFTER_MS
          )
            return null
          db.prepare(`UPDATE memory_dream_generations SET status='requested',attempt_id=?,run_id=?,requested_at=?,error=NULL,updated_at=?
          WHERE workspace_id=? AND dream_id=?`).run(
            randomUUID(),
            runId,
            now,
            now,
            workspaceId,
            dreamId
          )
          dreams.markExecutionRequested(workspaceId, dreamId, runId)
          return requireRun(workspaceId, dreamId)
        })
        .immediate()
    },
    fail(workspaceId: string, dreamId: string, attemptId: string, error: string) {
      db.transaction(() => {
        const row = readDreamGenerationRow(db, workspaceId, dreamId)
        if (!row || row.status !== 'requested' || row.attempt_id !== attemptId) return
        const reason = error.slice(0, 1000)
        db.prepare(
          "UPDATE memory_dream_generations SET status='failed',error=?,updated_at=? WHERE workspace_id=? AND dream_id=?"
        ).run(reason, Date.now(), workspaceId, dreamId)
        dreams.markExecutionFailed(workspaceId, dreamId, reason)
      }).immediate()
    },
    complete(
      workspaceId: string,
      dreamId: string,
      runId: string,
      attemptId: string,
      inputHash: string,
      value: unknown
    ) {
      return db
        .transaction(() => {
          const row = readDreamGenerationRow(db, workspaceId, dreamId)
          if (
            !row ||
            row.attempt_id !== attemptId ||
            row.run_id !== runId ||
            row.input_hash !== inputHash
          )
            throw new ConflictError(
              'Dream attempt or input changed. Read the current input before sending a result.'
            )
          const input = JSON.parse(row.input_json) as MemoryDreamGeneration['input']
          const result = parseDreamGenerationResult(value, input)
          const resultHash = dreamHash(result)
          if (row.status === 'completed') {
            if (row.result_hash !== resultHash)
              throw new ConflictError('This Dream attempt already saved a different result')
            return requireRun(workspaceId, dreamId)
          }
          if (row.status !== 'requested')
            throw new ConflictError('Dream generation is not awaiting a result')
          const consumed = cursor(workspaceId)
          if (
            consumed.sequence !== input.from.sequence ||
            consumed.offset !== input.from.offset ||
            (consumed.source_hash ?? null) !== (input.from.source_hash ?? null)
          )
            throw new ConflictError('The consumed message cursor changed')
          const operations: MemoryDreamOperation[] = result.candidates.map(
            ({ source_sequences, ...candidate }) => ({
              id: randomUUID(),
              action: 'add',
              sources: [],
              message_sources: source_sequences,
              result: candidate,
            })
          )
          const now = Date.now()
          db.prepare(`UPDATE memory_dream_runs SET operations_json=?,plan_revision=plan_revision+1,status=?,
          execution_status='completed',execution_error=NULL,updated_at=? WHERE workspace_id=? AND id=?`).run(
            JSON.stringify(operations),
            operations.length ? 'review' : 'discarded',
            now,
            workspaceId,
            dreamId
          )
          db.prepare(`UPDATE memory_dream_generations SET status='completed',result_json=?,result_hash=?,candidate_count=?,
          result_summary=?,completed_at=?,error=NULL,updated_at=? WHERE workspace_id=? AND dream_id=?`).run(
            JSON.stringify(result),
            resultHash,
            operations.length,
            result.summary,
            now,
            now,
            workspaceId,
            dreamId
          )
          // Candidate publication and cursor consumption commit together; neither implies application.
          db.prepare(`INSERT INTO memory_dream_cursors(workspace_id,sequence,offset,source_hash,updated_at) VALUES (?,?,?,?,?)
          ON CONFLICT(workspace_id) DO UPDATE SET sequence=excluded.sequence,offset=excluded.offset,
          source_hash=excluded.source_hash,updated_at=excluded.updated_at`).run(
            workspaceId,
            input.to.sequence,
            input.to.offset,
            input.to.source_hash ?? null,
            now
          )
          return requireRun(workspaceId, dreamId)
        })
        .immediate()
    },
  }
}
