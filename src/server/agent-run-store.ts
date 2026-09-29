import type { SessionIdCaptureConfig } from './session-capture.js'
import { parseSessionIdCapture } from './session-capture.js'
import type { Database } from './sqlite.js'

export interface AgentLaunchConfigInput {
  command: string
  args?: string[]
  commandPresetId?: string | null
  interactiveCommand?: string | null
  presetAugmentationDisabled?: boolean
  resumedSessionId?: string | null
  resumeArgsTemplate?: string | null
  sessionIdCapture?: SessionIdCaptureConfig | null
}

export interface PersistedAgentRun {
  runId: string
  agentId: string
  status: 'starting' | 'running' | 'exited' | 'error'
  exitCode: number | null
  pid: number | null
  startedAt: number
  endedAt: number | null
}

export interface InterruptedAgentRun extends PersistedAgentRun {
  consecutiveFastExits: number
  workspaceId: string
}

export const FAST_EXIT_WINDOW_MS = 10_000

const parseArgsJson = (argsJson: string, agentId: string) => {
  try {
    const parsed = JSON.parse(argsJson) as unknown
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed
    }
  } catch (error) {
    console.warn(`Invalid args_json for agent ${agentId}; falling back to empty args`, error)
    return []
  }

  console.warn(`Invalid args_json for agent ${agentId}; falling back to empty args`)
  return []
}

interface LaunchConfigRow {
  workspace_id: string
  agent_id: string
  command: string
  args_json: string
  command_preset_id: string | null
  interactive_command: string | null
  preset_augmentation_disabled: number | null
  resume_args_template: string | null
  session_id_capture_json: string | null
}

const parseSessionIdCaptureJson = (value: string | null) => {
  if (!value) return null
  return parseSessionIdCapture(JSON.parse(value))
}

interface AgentRunRow {
  run_id: string
  agent_id: string
  pid: number | null
  status: 'starting' | 'running' | 'exited' | 'error'
  exit_code: number | null
  started_at: number
  ended_at: number | null
  consecutive_fast_exits: number
}

interface InterruptedAgentRunRow extends AgentRunRow {
  workspace_id: string
}

export const createAgentRunStore = (db: Database) => {
  let closed = false
  const shutdownRuns = new Set<string>()

  const close = () => {
    closed = true
  }

  const listLaunchConfigs = () => {
    if (closed) {
      return []
    }

    return db
      .prepare(
        `SELECT workspace_id, agent_id, command, args_json, command_preset_id, interactive_command, preset_augmentation_disabled, resume_args_template, session_id_capture_json
         FROM agent_launch_configs ORDER BY updated_at ASC`
      )
      .all()
      .map((row: unknown) => {
        const typedRow = row as LaunchConfigRow
        return {
          agentId: typedRow.agent_id,
          config: {
            command: typedRow.command,
            args: parseArgsJson(typedRow.args_json, typedRow.agent_id),
            commandPresetId: typedRow.command_preset_id,
            interactiveCommand: typedRow.interactive_command,
            presetAugmentationDisabled: typedRow.preset_augmentation_disabled === 1,
            resumeArgsTemplate: typedRow.resume_args_template,
            sessionIdCapture: parseSessionIdCaptureJson(typedRow.session_id_capture_json),
          },
          workspaceId: typedRow.workspace_id,
        }
      })
  }

  const saveLaunchConfig = (
    workspaceId: string,
    agentId: string,
    input: AgentLaunchConfigInput
  ) => {
    if (closed) {
      return
    }
    const createdAt = Date.now()
    db.prepare(
      `INSERT INTO agent_launch_configs (
         workspace_id,
         agent_id,
         command,
         args_json,
         command_preset_id,
         interactive_command,
         preset_augmentation_disabled,
         resume_args_template,
         session_id_capture_json,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, agent_id) DO UPDATE SET
          command = excluded.command,
          args_json = excluded.args_json,
          command_preset_id = excluded.command_preset_id,
          interactive_command = excluded.interactive_command,
          preset_augmentation_disabled = excluded.preset_augmentation_disabled,
          resume_args_template = excluded.resume_args_template,
          session_id_capture_json = excluded.session_id_capture_json,
          updated_at = excluded.updated_at`
    ).run(
      workspaceId,
      agentId,
      input.command,
      JSON.stringify(input.args ?? []),
      input.commandPresetId ?? null,
      input.interactiveCommand ?? null,
      input.presetAugmentationDisabled ? 1 : 0,
      input.resumeArgsTemplate ?? null,
      input.sessionIdCapture ? JSON.stringify(input.sessionIdCapture) : null,
      createdAt,
      createdAt
    )
  }

  const deleteLaunchConfig = (workspaceId: string, agentId: string) => {
    if (closed) {
      return
    }
    db.prepare('DELETE FROM agent_launch_configs WHERE workspace_id = ? AND agent_id = ?').run(
      workspaceId,
      agentId
    )
  }

  const insertAgentRun = (
    runId: string,
    agentId: string,
    startedAt: number,
    pid: number | null,
    status: PersistedAgentRun['status'] = 'starting',
    exitCode: number | null = null,
    endedAt: number | null = null
  ) => {
    if (closed) return
    db.transaction(() => {
      const previous = db
        .prepare(
          'SELECT consecutive_fast_exits, resume_on_restart FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1'
        )
        .get(agentId) as { consecutive_fast_exits: number; resume_on_restart: number } | undefined
      db.prepare(
        `INSERT INTO agent_runs (
         run_id, agent_id, pid, status, exit_code, started_at, ended_at,
         consecutive_fast_exits, created_at, updated_at, resume_on_restart
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        runId,
        agentId,
        pid,
        status,
        exitCode,
        startedAt,
        endedAt,
        previous?.consecutive_fast_exits ?? 0,
        startedAt,
        startedAt,
        status === 'exited' ? 0 : (previous?.resume_on_restart ?? 0)
      )
      db.prepare(
        'UPDATE agent_runs SET resume_on_restart = 0 WHERE agent_id = ? AND run_id != ?'
      ).run(agentId, runId)
    })()
  }

  const updatePersistedRun = (
    runId: string,
    status: PersistedAgentRun['status'],
    exitCode: number | null,
    endedAt: number | null
  ) => {
    if (closed) {
      return
    }
    const current = db
      .prepare(
        'SELECT started_at, ended_at, consecutive_fast_exits, resume_on_restart FROM agent_runs WHERE run_id = ?'
      )
      .get(runId) as
      | {
          consecutive_fast_exits: number
          resume_on_restart: number
          started_at: number
          ended_at: number | null
        }
      | undefined
    let consecutiveFastExits = current?.consecutive_fast_exits ?? 0
    if (
      !shutdownRuns.has(runId) &&
      current?.ended_at === null &&
      endedAt !== null &&
      status !== 'starting' &&
      status !== 'running'
    ) {
      const fastExit =
        exitCode !== null &&
        exitCode !== 0 &&
        endedAt - (current?.started_at ?? endedAt) < FAST_EXIT_WINDOW_MS
      consecutiveFastExits = fastExit ? consecutiveFastExits + 1 : 0
    }
    db.prepare(
      `UPDATE agent_runs
       SET status = ?, exit_code = ?, ended_at = ?, consecutive_fast_exits = ?, updated_at = ?, resume_on_restart = ?
       WHERE run_id = ?`
    ).run(
      status,
      exitCode,
      endedAt,
      consecutiveFastExits,
      Date.now(),
      status === 'exited' && !shutdownRuns.has(runId) ? 0 : (current?.resume_on_restart ?? 0),
      runId
    )
  }

  const listAgentRuns = (agentId: string) => {
    if (closed) {
      return []
    }

    return db
      .prepare(
        'SELECT run_id, agent_id, pid, status, exit_code, started_at, ended_at FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC, rowid DESC'
      )
      .all(agentId)
      .map((row: unknown) => {
        const typedRow = row as AgentRunRow
        return {
          runId: typedRow.run_id,
          agentId: typedRow.agent_id,
          pid: typedRow.pid,
          status: typedRow.status,
          exitCode: typedRow.exit_code,
          startedAt: typedRow.started_at,
          endedAt: typedRow.ended_at,
        }
      }) satisfies PersistedAgentRun[]
  }

  const listInterruptedRuns = () => {
    if (closed) return []

    return db
      .prepare(
        `SELECT r.run_id, r.agent_id, r.pid, r.status, r.exit_code, r.started_at, r.ended_at,
                r.consecutive_fast_exits, c.workspace_id
         FROM agent_runs r
         INNER JOIN agent_launch_configs c ON c.agent_id = r.agent_id
         WHERE (r.status IN ('starting', 'running') OR r.resume_on_restart = 1)
           AND NOT EXISTS (SELECT 1 FROM workers w WHERE w.id=r.agent_id AND (w.retired_at IS NOT NULL OR w.preparation_state!='ready'))
           AND r.rowid = (
             SELECT latest.rowid FROM agent_runs latest
             WHERE latest.agent_id = r.agent_id
             ORDER BY latest.started_at DESC, latest.rowid DESC LIMIT 1
           )
         ORDER BY r.started_at ASC`
      )
      .all()
      .map((row: unknown) => {
        const typedRow = row as InterruptedAgentRunRow
        return {
          agentId: typedRow.agent_id,
          consecutiveFastExits: typedRow.consecutive_fast_exits,
          endedAt: typedRow.ended_at,
          exitCode: typedRow.exit_code,
          pid: typedRow.pid,
          runId: typedRow.run_id,
          startedAt: typedRow.started_at,
          status: typedRow.status,
          workspaceId: typedRow.workspace_id,
        } satisfies InterruptedAgentRun
      })
  }

  const checkpointShutdownRuns = (runIds: string[]) => {
    if (closed) return
    const checkpoint = db.prepare(
      `UPDATE agent_runs SET resume_on_restart = 1, updated_at = ?
       WHERE run_id = ? AND status IN ('starting', 'running')`
    )
    db.transaction(() => {
      const updatedAt = Date.now()
      for (const runId of runIds) checkpoint.run(updatedAt, runId)
    })()
    for (const runId of runIds) shutdownRuns.add(runId)
  }

  const resetFastExitCount = (agentId: string) => {
    if (closed) return
    db.prepare('UPDATE agent_runs SET consecutive_fast_exits = 0 WHERE agent_id = ?').run(agentId)
  }

  const markUnfinishedRunsStale = (endedAt = Date.now()) => {
    if (closed) {
      return
    }
    db.prepare(
      `UPDATE agent_runs
       SET status = 'error', exit_code = NULL, ended_at = ?, updated_at = ?, resume_on_restart = 1
       WHERE status IN ('starting', 'running')`
    ).run(endedAt, endedAt)
  }

  return {
    checkpointShutdownRuns,
    close,
    insertAgentRun,
    deleteLaunchConfig,
    listAgentRuns,
    listInterruptedRuns,
    listLaunchConfigs,
    markUnfinishedRunsStale,
    resetFastExitCount,
    saveLaunchConfig,
    updatePersistedRun,
  }
}
