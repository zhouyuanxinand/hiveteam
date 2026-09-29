import { BadRequestError } from './http-errors.js'
import type { Database as SqliteDatabase } from './sqlite.js'
import Database from './sqlite.js'
import { CURRENT_SCHEMA_VERSION, initializeRuntimeDatabase } from './sqlite-schema.js'

// Explicit record catalogue: unknown future tables never enter an export by default.
const TABLES = new Set(
  `schema_version workspaces workers messages agent_runs agent_sessions agent_session_contexts command_presets role_templates app_state
 clarification_requests dispatches dispatch_messages report_outbox dispatch_delivery_failures dispatch_health dispatch_health_events dispatch_timeout_settings dispatch_timeout_events message_deliveries message_delivery_events
 dispatch_code_reviews dispatch_verifications dispatch_integrations dispatch_pull_requests integration_candidates integration_candidate_events dispatch_skill_activations
 execution_policy_events execution_policy_snapshots external_goal_sessions external_goal_events git_snapshots git_workspace_settings
 memory_entries memory_sources memory_injections memory_revisions memory_context_snapshots memory_dream_runs memory_dream_reviews memory_dream_generations memory_dream_cursors memory_dream_deleted_sources
 native_session_generations native_session_attempts native_session_context_events remote_audit resource_limits resource_limit_audit
 skill_pack_releases skill_snapshots skill_change_plans skill_change_attempts skill_placements verification_profiles worker_branch_updates worker_worktrees worktree_resources
 workflow_runs workflow_step_attempts workspace_creation_attempts workspace_review_confirmations workspace_review_drafts workspace_review_submissions dispatch_archives data_archive_operations`.split(
    /\s+/u
  )
)
const JSON_COLUMNS = new Set([
  'args',
  'env',
  'default_args',
  'default_env',
  'session_id_capture',
  'yolo_args_template',
  'snapshot',
  'settings',
  'timeouts',
  'before_settings',
  'after_settings',
])
const scrubObject = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(scrubObject)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      /(?:token|secret|password|credential|private.?key|d2p.?key|p2d.?key)/iu.test(key)
        ? null
        : /^(?:env|environment|default_env)$/iu.test(key)
          ? {}
          : /^(?:args|argv|command|executable|shellCommand)$/iu.test(key)
            ? null
            : scrubObject(entry),
    ])
  )
}
const sanitizeRow = (table: string, row: Record<string, unknown>) => {
  if (
    table === 'app_state' &&
    !(
      row.key === 'active_workspace_id' ||
      /^workspace:[^:]+:memory_(?:enabled|dream_enabled|budget)$/u.test(String(row.key))
    )
  )
    return null
  const next = { ...row }
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === 'string' && (key.endsWith('_json') || JSON_COLUMNS.has(key))) {
      try {
        next[key] = JSON.stringify(scrubObject(JSON.parse(value)))
      } catch (cause) {
        throw Object.assign(new BadRequestError(`Invalid structured value in ${table}.${key}`), {
          cause,
        })
      }
    }
  }
  if (table === 'command_presets') {
    next.command = '[requires-cli-rebind]'
    next.args = '[]'
    next.env = '{}'
    next.yolo_args_template = '[]'
    next.resume_args_template = null
    next.session_id_capture = null
  }
  if (table === 'role_templates') {
    next.default_command = '[requires-cli-rebind]'
    next.default_args = '[]'
    next.default_env = '{}'
  }
  return next
}
export const databaseSchema = (db: SqliteDatabase) =>
  db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"
    )
    .all()
export const validateBackupDatabase = (db: SqliteDatabase) => {
  db.pragma('trusted_schema = OFF')
  const version = (
    db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }
  ).version
  if (version !== CURRENT_SCHEMA_VERSION)
    throw new BadRequestError(
      `Backup schema ${version} is incompatible with ${CURRENT_SCHEMA_VERSION}`
    )
  const reference = new Database(':memory:')
  try {
    initializeRuntimeDatabase(reference)
    if (JSON.stringify(databaseSchema(reference)) !== JSON.stringify(databaseSchema(db)))
      throw new BadRequestError('Backup database schema does not match the supported schema')
  } finally {
    reference.close()
  }
  if (
    db.pragma('integrity_check', { simple: true }) !== 'ok' ||
    (db.pragma('foreign_key_check') as unknown[]).length
  )
    throw new BadRequestError('Backup database integrity check failed')
}
export const exportBackupDatabase = (source: SqliteDatabase, targetPath: string) => {
  const target = new Database(targetPath)
  try {
    initializeRuntimeDatabase(target)
    target.pragma('foreign_keys=OFF')
    target.pragma('journal_mode=DELETE')
    const triggers = target
      .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'")
      .all() as Array<{ name: string; sql: string }>
    target.transaction(() => {
      for (const trigger of triggers) target.exec(`DROP TRIGGER "${trigger.name}"`)
      const tables = target
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
      for (const { name } of tables) target.prepare(`DELETE FROM "${name}"`).run()
      for (const { name } of tables) {
        if (!TABLES.has(name)) continue
        const columns = (target.pragma(`table_info("${name}")`) as Array<{ name: string }>).map(
          (column) => column.name
        )
        const insert = target.prepare(
          `INSERT INTO "${name}"(${columns.map((c) => `"${c}"`).join(',')}) VALUES(${columns.map(() => '?').join(',')})`
        )
        for (const row of source.prepare(`SELECT * FROM "${name}"`).iterate() as Iterable<
          Record<string, unknown>
        >) {
          const safe = sanitizeRow(name, row)
          if (safe) insert.run(...columns.map((column) => safe[column]))
        }
      }
      for (const trigger of triggers) target.exec(trigger.sql)
    })()
    target.pragma('foreign_keys=ON')
    validateBackupDatabase(target)
    const counts = Object.fromEntries(
      [...TABLES].map((name) => [
        name,
        (target.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get() as { count: number })
          .count,
      ])
    )
    return counts
  } finally {
    target.close()
  }
}
