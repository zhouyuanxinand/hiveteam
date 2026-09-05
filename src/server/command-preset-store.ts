import { randomUUID } from 'node:crypto'

import type { Database } from 'better-sqlite3'

import { ConflictError } from './http-errors.js'
import { parseSessionIdCapture, type SessionIdCaptureConfig } from './session-capture.js'

export interface CommandPresetRecord {
  id: string
  displayName: string
  command: string
  args: string[]
  env: Record<string, string>
  resumeArgsTemplate: string | null
  sessionIdCapture: SessionIdCaptureConfig | null
  yoloArgsTemplate: string[] | null
  isBuiltin: boolean
}

export interface CommandPresetInput {
  displayName: string
  command: string
  args: string[]
  env: Record<string, string>
  resumeArgsTemplate: string | null
  sessionIdCapture: SessionIdCaptureConfig | null
  yoloArgsTemplate: string[] | null
}

const parseStringArray = (value: string | null) => {
  if (!value) return []
  const parsed = JSON.parse(value) as unknown
  return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : []
}

const parseEnv = (value: string | null) => {
  if (!value) return {}
  const parsed = JSON.parse(value) as unknown
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      )
    : {}
}

const parseJsonBlob = (value: string | null) => {
  if (!value) return null
  return parseSessionIdCapture(JSON.parse(value))
}

const serializeArgs = (args: string[]) => JSON.stringify(args)
const serializeEnv = (env: Record<string, string>) => JSON.stringify(env)
const serializeBlob = (value: SessionIdCaptureConfig | null) =>
  value ? JSON.stringify(value) : null
const serializeYolo = (value: string[] | null) => (value ? JSON.stringify(value) : null)

const toRecord = (row: {
  id: string
  display_name: string
  command: string
  args: string
  env: string
  resume_args_template: string | null
  session_id_capture: string | null
  yolo_args_template: string | null
  is_builtin: number
}): CommandPresetRecord => ({
  id: row.id,
  displayName: row.display_name,
  command: row.command,
  args: parseStringArray(row.args),
  env: parseEnv(row.env),
  resumeArgsTemplate: row.resume_args_template,
  sessionIdCapture: parseJsonBlob(row.session_id_capture),
  yoloArgsTemplate: parseStringArray(row.yolo_args_template),
  isBuiltin: row.is_builtin === 1,
})

export const createCommandPresetStore = (db: Database) => {
  const selectColumns =
    'id, display_name, command, args, env, resume_args_template, session_id_capture, yolo_args_template, is_builtin'
  const listStmt = db.prepare(
    `SELECT ${selectColumns} FROM command_presets ORDER BY is_builtin DESC, created_at ASC`
  )
  const insertStmt = db.prepare(
    `INSERT INTO command_presets (
       id, display_name, command, args, env, resume_args_template, session_id_capture,
       yolo_args_template, is_builtin, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  )
  const updateStmt = db.prepare(
    `UPDATE command_presets
     SET display_name = ?, command = ?, args = ?, env = ?, resume_args_template = ?,
         session_id_capture = ?, yolo_args_template = ?, updated_at = ?
     WHERE id = ?`
  )
  const removeStmt = db.prepare('DELETE FROM command_presets WHERE id = ?')

  // Presets change only through this store, and the team-list enrichment reads
  // one preset per worker per UI poll — memoize rows and drop the per-poll
  // SQLite round trips and JSON re-parsing entirely.
  let cache: { byId: Map<string, CommandPresetRecord>; ordered: CommandPresetRecord[] } | null =
    null

  const readAll = () => {
    if (!cache) {
      const ordered = listStmt.all().map((row) => toRecord(row as Parameters<typeof toRecord>[0]))
      cache = { byId: new Map(ordered.map((record) => [record.id, record])), ordered }
    }
    return cache
  }

  const get = (id: string) => readAll().byId.get(id)

  const list = () => [...readAll().ordered]

  const create = (input: CommandPresetInput) => {
    const record = { id: randomUUID(), ...input, isBuiltin: false }
    const now = Date.now()
    insertStmt.run(
      record.id,
      record.displayName,
      record.command,
      serializeArgs(record.args),
      serializeEnv(record.env),
      record.resumeArgsTemplate,
      serializeBlob(record.sessionIdCapture),
      serializeYolo(record.yoloArgsTemplate),
      now,
      now
    )
    cache = null
    return record
  }

  const update = (id: string, input: CommandPresetInput) => {
    const current = get(id)
    if (!current) throw new Error(`Command preset not found: ${id}`)
    if (current.isBuiltin) throw new ConflictError(`Builtin command preset is read-only: ${id}`)
    updateStmt.run(
      input.displayName,
      input.command,
      serializeArgs(input.args),
      serializeEnv(input.env),
      input.resumeArgsTemplate,
      serializeBlob(input.sessionIdCapture),
      serializeYolo(input.yoloArgsTemplate),
      Date.now(),
      id
    )
    cache = null
    return { ...current, ...input }
  }

  const remove = (id: string) => {
    const current = get(id)
    if (!current) throw new Error(`Command preset not found: ${id}`)
    if (current.isBuiltin) throw new ConflictError(`Builtin command preset is read-only: ${id}`)
    removeStmt.run(id)
    cache = null
  }

  return { create, get, list, remove, update }
}
