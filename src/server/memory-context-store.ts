import { createHash, randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { MemoryContextSnapshot, MemorySelection } from '../shared/memory-context.js'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
export const createMemoryContextStore = (db: Database) => {
  const sources = (memoryId: string) =>
    (
      db
        .prepare(
          'SELECT id,source_type,source_id,text_hash FROM memory_sources WHERE memory_id=? ORDER BY id'
        )
        .all(memoryId) as Array<{
        id: string
        source_type: string
        source_id: string | null
        text_hash: string | null
      }>
    ).map((source) => {
      // An explicit reference vocabulary; never resolve a memory string as a filesystem path.
      let text: string | null = null
      if (source.source_type === 'dispatch' && source.source_id) {
        const row = db
          .prepare('SELECT text,report_text,report_revision FROM dispatches WHERE id=?')
          .get(source.source_id) as
          | { text: string; report_text: string | null; report_revision: number }
          | undefined
        if (row) text = JSON.stringify(row)
      } else if (source.source_type === 'memory' && source.source_id) {
        const row = db
          .prepare('SELECT body,revision FROM memory_entries WHERE id=?')
          .get(source.source_id) as { body: string; revision: number } | undefined
        if (row) text = JSON.stringify(row)
      }
      const version = text === null ? null : hash(text)
      return {
        id: source.id,
        source_id: source.source_id,
        type: source.source_type,
        version,
        captured_version: source.text_hash,
        state:
          version === null || source.text_hash === null
            ? ('unknown' as const)
            : version === source.text_hash
              ? ('current' as const)
              : ('stale' as const),
      }
    })
  return {
    sources,
    recordContext(input: Omit<MemoryContextSnapshot, 'id' | 'created_at'>) {
      const snapshot = { ...input, id: randomUUID(), created_at: Date.now() }
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
            .prepare('SELECT revision FROM memory_entries WHERE id=?')
            .get(candidate.memory_id) as { revision: number } | undefined
          const currentSources = sources(candidate.memory_id)
          return {
            ...candidate,
            memory_changed: current?.revision !== candidate.revision,
            sources: candidate.sources.map((source) => ({
              ...source,
              stale:
                currentSources.find((item) => item.id === source.id)?.version !== source.version ||
                source.state === 'stale',
            })),
          }
        }),
      }))
    },
  }
}
