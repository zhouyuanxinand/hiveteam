import { randomUUID } from 'node:crypto'

import type { Database } from 'better-sqlite3'

import type { SkillMemberInspection, SkillScanStatus } from '../shared/skill-packs.js'

export interface SkillSnapshotRecord {
  agentId: string
  commandPresetId: string | null
  createdAt: number
  error: string | null
  fingerprint: string
  id: string
  snapshot: SkillMemberInspection
  status: SkillScanStatus
  workspaceId: string
}

interface SkillSnapshotRow {
  agent_id: string
  command_preset_id: string | null
  created_at: number
  error: string | null
  fingerprint: string
  id: string
  snapshot_json: string
  status: SkillScanStatus
  workspace_id: string
}

const fromRow = (row: SkillSnapshotRow): SkillSnapshotRecord => ({
  agentId: row.agent_id,
  commandPresetId: row.command_preset_id,
  createdAt: row.created_at,
  error: row.error,
  fingerprint: row.fingerprint,
  id: row.id,
  snapshot: JSON.parse(row.snapshot_json) as SkillMemberInspection,
  status: row.status,
  workspaceId: row.workspace_id,
})

export const createSkillSnapshotStore = (db: Database) => {
  const insertWorkspaceSnapshots = (
    workspaceId: string,
    inputs: Array<{
      fingerprint: string
      member: SkillMemberInspection
    }>
  ): SkillSnapshotRecord[] => {
    const createdAt = Date.now()
    const insert = db.prepare(
      `INSERT INTO skill_snapshots (
         id, workspace_id, agent_id, command_preset_id, snapshot_json,
         fingerprint, status, error, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const records = inputs.map(({ fingerprint, member }) => ({
      agentId: member.agentId,
      commandPresetId: member.commandPresetId,
      createdAt,
      error: member.error,
      fingerprint,
      id: randomUUID(),
      snapshot: member,
      status: member.scanStatus,
      workspaceId,
    }))

    db.transaction(() => {
      for (const record of records) {
        insert.run(
          record.id,
          record.workspaceId,
          record.agentId,
          record.commandPresetId,
          JSON.stringify(record.snapshot),
          record.fingerprint,
          record.status,
          record.error,
          record.createdAt
        )
      }
    })()
    return records
  }

  const listLatest = (workspaceId: string): SkillSnapshotRecord[] =>
    (
      db
        .prepare(
          `SELECT id, workspace_id, agent_id, command_preset_id, snapshot_json,
                  fingerprint, status, error, created_at
           FROM skill_snapshots AS snapshot
           WHERE workspace_id = ?
             AND sequence = (
               SELECT MAX(candidate.sequence)
               FROM skill_snapshots AS candidate
               WHERE candidate.workspace_id = snapshot.workspace_id
                 AND candidate.agent_id = snapshot.agent_id
             )
           ORDER BY agent_id, id`
        )
        .all(workspaceId) as SkillSnapshotRow[]
    ).map(fromRow)

  const deleteAgent = (workspaceId: string, agentId: string) => {
    db.prepare('DELETE FROM skill_snapshots WHERE workspace_id = ? AND agent_id = ?').run(
      workspaceId,
      agentId
    )
  }

  const deleteWorkspace = (workspaceId: string) => {
    db.prepare('DELETE FROM skill_snapshots WHERE workspace_id = ?').run(workspaceId)
  }

  return {
    deleteAgent,
    deleteWorkspace,
    insertWorkspaceSnapshots,
    listLatest,
  }
}
