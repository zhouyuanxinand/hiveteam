import type { Database } from 'better-sqlite3'

import { BUILTIN_COMMAND_PRESETS } from './command-preset-defaults.js'

/** Backfill new built-in CLI presets without replacing user configuration. */
export const applySchemaVersion21 = (db: Database) => {
  const commandPresetTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'command_presets'")
    .get() as { name: string } | undefined
  if (!commandPresetTable) return

  const now = Date.now()
  const insertPreset = db.prepare(
    `INSERT INTO command_presets (
       id, display_name, command, args, env, resume_args_template, session_id_capture,
       yolo_args_template, is_builtin, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  )

  for (const preset of BUILTIN_COMMAND_PRESETS) {
    insertPreset.run(
      preset.id,
      preset.displayName,
      preset.command,
      '[]',
      '{}',
      preset.resumeArgsTemplate,
      preset.sessionIdCapture ? JSON.stringify(preset.sessionIdCapture) : null,
      preset.yoloArgsTemplate ? JSON.stringify(preset.yoloArgsTemplate) : null,
      now,
      now
    )
  }
}
