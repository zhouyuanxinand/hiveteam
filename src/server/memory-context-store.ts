import { randomUUID } from 'node:crypto'
import type { MemoryContextSnapshot, MemorySelection } from '../shared/memory-context.js'
import { BadRequestError } from './http-errors.js'
import { createMemoryProvenanceStore } from './memory-provenance-store.js'
import type { Database } from './sqlite.js'

export const createMemoryContextStore = (db: Database) => {
  const { sources } = createMemoryProvenanceStore(db)
  return {
    sources,
    recordPreparation(input: Omit<MemoryContextSnapshot, 'id' | 'created_at'>) {
      const snapshot = { ...input, id: randomUUID(), created_at: Date.now() }
      return db.transaction(() => {
        if (input.dispatch_id !== null) {
          const dispatch = db
            .prepare('SELECT 1 FROM dispatches WHERE workspace_id=? AND id=? AND to_agent_id=?')
            .get(input.workspace_id, input.dispatch_id, input.agent_id)
          if (input.context !== 'dispatch' || !dispatch)
            throw new BadRequestError('Dispatch does not match the memory context')
        }
        for (const candidate of input.candidates.filter((item) => item.selected)) {
          const memory = db
            .prepare(`SELECT 1 FROM memory_entries WHERE id=? AND revision=?
            AND status='active' AND disabled=0 AND (workspace_id=? OR (workspace_id IS NULL AND scope='user'))`)
            .get(candidate.memory_id, candidate.revision, input.workspace_id)
          if (!memory)
            throw new BadRequestError('Selected memory is not eligible in this workspace')
          db.prepare(`INSERT INTO memory_injections
            (id,memory_id,workspace_id,target_agent_id_snapshot,context_type,dispatch_id,injected_at)
            VALUES(?,?,?,?,?,?,?)`).run(
            randomUUID(),
            candidate.memory_id,
            input.workspace_id,
            input.agent_id,
            input.context,
            input.dispatch_id,
            snapshot.created_at
          )
          db.prepare('UPDATE memory_entries SET last_injected_at=? WHERE id=?').run(
            snapshot.created_at,
            candidate.memory_id
          )
        }
        db.prepare('INSERT INTO memory_context_snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
          snapshot.id,
          snapshot.workspace_id,
          snapshot.agent_id,
          snapshot.context,
          snapshot.dispatch_id,
          snapshot.run_id,
          snapshot.query,
          snapshot.budget,
          snapshot.used_chars,
          snapshot.digest,
          JSON.stringify(snapshot.candidates),
          snapshot.created_at
        )
        return snapshot
      })()
    },
    contexts(workspaceId: string, dispatchId?: string, limit = 20) {
      const rows = db
        .prepare(
          `SELECT * FROM memory_context_snapshots WHERE workspace_id=? ${dispatchId ? 'AND dispatch_id=?' : ''} ORDER BY created_at DESC,id DESC LIMIT ?`
        )
        .all(
          ...(dispatchId ? [workspaceId, dispatchId] : [workspaceId]),
          Math.min(100, Math.max(1, limit))
        ) as Array<Omit<MemoryContextSnapshot, 'candidates'> & { candidates_json: string }>
      return rows.map(({ candidates_json, ...row }) => ({
        ...row,
        candidates: (JSON.parse(candidates_json) as MemorySelection[]).map((candidate) => {
          const current = db
            .prepare(
              "SELECT revision FROM memory_entries WHERE id=? AND (workspace_id=? OR (workspace_id IS NULL AND scope='user'))"
            )
            .get(candidate.memory_id, workspaceId) as { revision: number } | undefined
          const currentSources = sources(workspaceId, candidate.memory_id)
          return {
            ...candidate,
            memory_changed: current?.revision !== candidate.revision,
            sources: candidate.sources.map((source) => ({
              ...source,
              stale:
                source.state === 'stale' ||
                (source.version !== null &&
                  currentSources.find((item) => item.id === source.id)?.version !== source.version),
            })),
          }
        }),
      }))
    },
  }
}
