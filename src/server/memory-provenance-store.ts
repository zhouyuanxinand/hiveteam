import { createHash, randomUUID } from 'node:crypto'
import type { MemorySourceReference, MemorySourceSnapshot } from '../shared/memory-provenance.js'
import type { TeamMemoryEntry } from '../shared/team-memory.js'
import { BadRequestError, HttpError } from './http-errors.js'
import type { Database } from './sqlite.js'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
interface SourceRow {
  id: string
  source_type: string
  source_id: string | null
  source_workspace_id: string | null
  source_sequence: number | null
  excerpt: string | null
  text_hash: string | null
  actor_agent_id_snapshot: string | null
  actor_name_snapshot: string | null
  actor_role_snapshot: string | null
  created_at: number
  memory_workspace_id: string | null
}

export const createMemoryProvenanceStore = (db: Database) => {
  // Only protocol references are resolved here, never paths or caller-supplied author metadata.
  const resolve = (workspaceId: string, type: string, id: string, sequence: number | null) => {
    if (type === 'dispatch') {
      const row = db
        .prepare(`SELECT sequence,to_agent_id,text,report_text,report_revision
        FROM dispatches WHERE workspace_id=? AND id=?`)
        .get(workspaceId, id) as
        | {
            sequence: number
            to_agent_id: string
            text: string
            report_text: string | null
            report_revision: number
          }
        | undefined
      if (!row) return null
      return {
        author: row.to_agent_id,
        sequence: row.sequence,
        excerpt: row.report_text,
        version: hash({
          text: row.text,
          report_text: row.report_text,
          report_revision: row.report_revision,
        }),
      }
    }
    if (type === 'dispatch_message') {
      const row = db
        .prepare(`SELECT m.body,m.from_agent_id,m.to_agent_id,m.kind,m.reply_to
        FROM dispatch_messages m JOIN dispatches d ON d.id=m.dispatch_id
        WHERE d.workspace_id=? AND d.id=? AND m.sequence=?`)
        .get(workspaceId, id, sequence) as
        | {
            body: string
            from_agent_id: string
            to_agent_id: string
            kind: string
            reply_to: string | null
          }
        | undefined
      return row
        ? { author: row.from_agent_id, sequence, excerpt: row.body, version: hash(row) }
        : null
    }
    if (type === 'dream') {
      const row = db
        .prepare(
          `SELECT plan_revision,operations_json FROM memory_dream_runs WHERE workspace_id=? AND id=?`
        )
        .get(workspaceId, id) as { plan_revision: number; operations_json: string } | undefined
      return row
        ? {
            author: `${workspaceId}:orchestrator`,
            sequence: row.plan_revision,
            excerpt: null,
            version: hash(row),
          }
        : null
    }
    if (type === 'memory') {
      const row = db
        .prepare(`SELECT body,revision FROM memory_entries
        WHERE id=? AND (workspace_id=? OR (workspace_id IS NULL AND scope='user'))`)
        .get(id, workspaceId) as { body: string; revision: number } | undefined
      return row ? { author: null, sequence: null, excerpt: row.body, version: hash(row) } : null
    }
    return null
  }
  const author = (workspaceId: string, id: string | null) => {
    if (id === `${workspaceId}:orchestrator`) return { name: 'Orchestrator', role: 'orchestrator' }
    return id
      ? (db
          .prepare('SELECT name,role FROM workers WHERE workspace_id=? AND id=?')
          .get(workspaceId, id) as { name: string; role: string } | undefined)
      : undefined
  }
  return {
    capture(workspaceId: string, entry: TeamMemoryEntry, ref?: MemorySourceReference) {
      const resolved = ref
        ? resolve(
            workspaceId,
            ref.type,
            ref.source_id,
            ref.type === 'dispatch_message' ? ref.source_sequence : null
          )
        : null
      if (ref && !resolved) throw new HttpError(404, 'Memory source not found in this workspace')
      if (ref && !resolved?.excerpt)
        throw new BadRequestError('A reported dispatch is required as a memory source')
      const actorId = resolved?.author ?? entry.createdByAgentId
      const actor = author(workspaceId, actorId)
      const name = ref ? (actor?.name ?? null) : (actor?.name ?? entry.createdByAgentName)
      db.prepare(`INSERT INTO memory_sources (
        id,memory_id,source_type,source_id,source_sequence,excerpt,text_hash,
        actor_agent_id_snapshot,actor_name_snapshot,actor_role_snapshot,created_at,source_workspace_id
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        randomUUID(),
        entry.id,
        ref?.type ?? entry.source,
        ref?.source_id ?? null,
        resolved?.sequence ?? null,
        (resolved?.excerpt ?? entry.body).slice(0, 2000),
        resolved?.version ?? null,
        actorId,
        name,
        actor?.role ?? null,
        entry.createdAt,
        workspaceId
      )
      return { id: actorId, name }
    },
    sources(workspaceId: string, memoryId: string): MemorySourceSnapshot[] {
      const rows = db
        .prepare(`SELECT s.*,m.workspace_id AS memory_workspace_id
        FROM memory_sources s JOIN memory_entries m ON m.id=s.memory_id
        WHERE m.id=? AND (m.workspace_id=? OR (m.workspace_id IS NULL AND m.scope='user'))
        ORDER BY s.created_at,s.id`)
        .all(memoryId, workspaceId) as SourceRow[]
      return rows.map((source) => {
        const origin = source.source_workspace_id ?? source.memory_workspace_id
        const resolved =
          origin === null || origin === workspaceId
            ? source.source_id
              ? resolve(workspaceId, source.source_type, source.source_id, source.source_sequence)
              : null
            : null
        // Legacy global references with no known origin can only reveal evidence when the
        // canonical source can be resolved inside this workspace. Missing legacy data stays unknown.
        const restricted =
          (origin !== null && origin !== workspaceId) ||
          (origin === null && source.source_id !== null && !resolved)
        const version = restricted ? null : (resolved?.version ?? null)
        return {
          id: source.id,
          type: source.source_type,
          source_id: restricted ? null : source.source_id,
          source_workspace_id: restricted ? null : source.source_workspace_id,
          source_sequence: restricted ? null : source.source_sequence,
          excerpt: restricted ? null : source.excerpt,
          actor_agent_id_snapshot: restricted ? null : source.actor_agent_id_snapshot,
          actor_name_snapshot: restricted ? null : source.actor_name_snapshot,
          actor_role_snapshot: restricted ? null : source.actor_role_snapshot,
          created_at: source.created_at,
          version,
          captured_version: restricted ? null : source.text_hash,
          state: restricted
            ? 'restricted'
            : version === null || source.text_hash === null
              ? 'unknown'
              : version === source.text_hash
                ? 'current'
                : 'stale',
        }
      })
    },
  }
}
