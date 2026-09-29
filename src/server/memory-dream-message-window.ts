import { createHash } from 'node:crypto'
import { BadRequestError, ConflictError } from './http-errors.js'
import type { Database } from './sqlite.js'

export interface DreamMessageCursor {
  sequence: number
  offset: number
  source_hash?: string | null
}
export interface DreamMessageFragment {
  sequence: number
  type: 'user_input' | 'send' | 'report' | 'status' | 'feedback' | 'member_feedback'
  created_at: number
  from_agent_id: string | null
  to_agent_id: string | null
  text: string
  start_offset: number
  end_offset: number
  total_chars: number
  content_hash: string
}
export interface DreamMessageWindow {
  from: DreamMessageCursor
  to: DreamMessageCursor
  messages: DreamMessageFragment[]
}
interface MessageRow {
  sequence: number
  workspace_id: string
  worker_id: string
  type: DreamMessageFragment['type']
  created_at: number
  from_agent_id: string | null
  to_agent_id: string | null
  text: string
  purpose: string
}

const MAX_MESSAGES = 20
const MAX_CHARS = 12_000
const eligible = `purpose='conversation' AND text IS NOT NULL
  AND length(trim(text, char(9)||char(10)||char(11)||char(12)||char(13)||' '))>0
  AND (type IN ('user_input','send','report','feedback','member_feedback')
    OR (type='status' AND from_agent_id=worker_id
      AND (to_agent_id IS NULL OR to_agent_id<>worker_id)))`
const columns =
  'sequence,workspace_id,worker_id,type,created_at,from_agent_id,to_agent_id,text,purpose'
export const dreamMessageSourceHash = (row: MessageRow) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        sequence: row.sequence,
        workspace_id: row.workspace_id,
        worker_id: row.worker_id,
        type: row.type,
        created_at: row.created_at,
        from_agent_id: row.from_agent_id,
        to_agent_id: row.to_agent_id,
        text: row.text,
        purpose: row.purpose,
      })
    )
    .digest('hex')
const splitsSurrogate = (text: string, offset: number) =>
  offset > 0 &&
  offset < text.length &&
  text.charCodeAt(offset - 1) >= 0xd800 &&
  text.charCodeAt(offset - 1) <= 0xdbff &&
  text.charCodeAt(offset) >= 0xdc00 &&
  text.charCodeAt(offset) <= 0xdfff

const validateCursor = (cursor: DreamMessageCursor) => {
  if (
    !Number.isSafeInteger(cursor.sequence) ||
    cursor.sequence < 0 ||
    !Number.isSafeInteger(cursor.offset) ||
    cursor.offset < 0 ||
    (cursor.sequence === 0 && cursor.offset !== 0)
  )
    throw new BadRequestError('Dream message cursor must contain nonnegative sequence and offset')
}

/** A synchronous read transaction fixes both the selected evidence and its upper cursor. */
export const createMemoryDreamMessageWindow = (db: Database) => {
  const partial = db.prepare(`SELECT ${columns} FROM messages
    WHERE workspace_id=? AND sequence=? AND ${eligible}`)
  const next = db.prepare(`SELECT ${columns} FROM messages
    WHERE workspace_id=? AND sequence>? AND ${eligible} ORDER BY sequence LIMIT ?`)
  const exists = db.prepare(`SELECT 1 FROM messages
    WHERE workspace_id=? AND sequence>? AND ${eligible} LIMIT 1`)
  const partialSource = (workspaceId: string, cursor: DreamMessageCursor) => {
    const row = partial.get(workspaceId, cursor.sequence) as MessageRow | undefined
    if (
      !row &&
      cursor.source_hash &&
      !db.prepare('SELECT 1 FROM messages WHERE sequence=?').get(cursor.sequence) &&
      db
        .prepare(
          'SELECT 1 FROM memory_dream_deleted_sources WHERE workspace_id=? AND sequence=? AND source_hash=?'
        )
        .get(workspaceId, cursor.sequence, cursor.source_hash)
    )
      return null
    if (
      !row ||
      cursor.offset >= row.text.length ||
      splitsSurrogate(row.text, cursor.offset) ||
      !cursor.source_hash ||
      dreamMessageSourceHash(row) !== cursor.source_hash
    )
      throw new ConflictError(
        'The partially consumed Dream message changed or is unavailable. Its remaining evidence was not skipped.'
      )
    return row
  }
  const readDreamWindow = (
    workspaceId: string,
    cursor: DreamMessageCursor
  ): DreamMessageWindow | null => {
    validateCursor(cursor)
    return db.transaction(() => {
      const rows: MessageRow[] = []
      if (cursor.offset > 0) {
        const source = partialSource(workspaceId, cursor)
        if (source) rows.push(source)
      }
      rows.push(
        ...(next.all(workspaceId, cursor.sequence, MAX_MESSAGES - rows.length) as MessageRow[])
      )
      const messages: DreamMessageFragment[] = []
      let remaining = MAX_CHARS
      let to: DreamMessageCursor = { ...cursor }
      for (const row of rows) {
        const start = row.sequence === cursor.sequence ? cursor.offset : 0
        let end = Math.min(row.text.length, start + remaining)
        if (splitsSurrogate(row.text, end)) end -= 1
        if (end === start) break
        const hash = dreamMessageSourceHash(row)
        messages.push({
          sequence: row.sequence,
          type: row.type,
          created_at: row.created_at,
          from_agent_id: row.from_agent_id,
          to_agent_id: row.to_agent_id,
          text: row.text.slice(start, end),
          start_offset: start,
          end_offset: end,
          total_chars: row.text.length,
          content_hash: hash,
        })
        remaining -= end - start
        to =
          end < row.text.length
            ? { sequence: row.sequence, offset: end, source_hash: hash }
            : { sequence: row.sequence, offset: 0, source_hash: null }
        if (end < row.text.length || remaining === 0) break
      }
      return messages.length ? { from: { ...cursor }, to, messages } : null
    })()
  }
  return {
    readDreamWindow,
    hasDreamMessages: (workspaceId: string, cursor: DreamMessageCursor) => {
      validateCursor(cursor)
      if (cursor.offset > 0 && partialSource(workspaceId, cursor)) return true
      return !!exists.get(workspaceId, cursor.sequence)
    },
  }
}
