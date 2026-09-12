import type { Database } from 'better-sqlite3'

import type { DispatchSkillActivation, ResolvedSkillActivation } from '../shared/skill-packs.js'

interface ActivationRow {
  created_at: number
  delivery_mode: 'inline'
  dispatch_id: string
  instruction_snapshot: string
  pack_name: string
  payload_digest: string
  release_id: string
  skill_digest: string
  skill_name: string
}

const fromRow = (row: ActivationRow): DispatchSkillActivation => ({
  createdAt: row.created_at,
  deliveryMode: row.delivery_mode,
  dispatchId: row.dispatch_id,
  instructionSnapshot: row.instruction_snapshot,
  packName: row.pack_name,
  payloadDigest: row.payload_digest,
  releaseId: row.release_id,
  skillDigest: row.skill_digest,
  skillName: row.skill_name,
})

export const createDispatchSkillActivationStore = (db: Database) => {
  const insert = (dispatchId: string, activation: ResolvedSkillActivation) => {
    const createdAt = Date.now()
    db.prepare(
      `INSERT INTO dispatch_skill_activations (
         dispatch_id, release_id, pack_name, skill_name, skill_digest,
         instruction_snapshot, payload_digest, delivery_mode, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      dispatchId,
      activation.releaseId,
      activation.packName,
      activation.skillName,
      activation.skillDigest,
      activation.instructionSnapshot,
      activation.payloadDigest,
      activation.deliveryMode,
      createdAt
    )
    return { ...activation, createdAt, dispatchId }
  }

  const get = (dispatchId: string): DispatchSkillActivation | null => {
    const row = db
      .prepare(
        `SELECT dispatch_id, release_id, pack_name, skill_name, skill_digest,
                instruction_snapshot, payload_digest, delivery_mode, created_at
           FROM dispatch_skill_activations
          WHERE dispatch_id = ?`
      )
      .get(dispatchId) as ActivationRow | undefined
    return row ? fromRow(row) : null
  }

  const deleteDispatch = (dispatchId: string) => {
    db.prepare('DELETE FROM dispatch_skill_activations WHERE dispatch_id = ?').run(dispatchId)
  }

  const deleteWorkspace = (workspaceId: string) => {
    db.prepare(
      `DELETE FROM dispatch_skill_activations
       WHERE dispatch_id IN (SELECT id FROM dispatches WHERE workspace_id = ?)`
    ).run(workspaceId)
  }

  const deleteWorker = (workspaceId: string, workerId: string) => {
    db.prepare(
      `DELETE FROM dispatch_skill_activations
       WHERE dispatch_id IN (
         SELECT id FROM dispatches WHERE workspace_id = ? AND to_agent_id = ?
       )`
    ).run(workspaceId, workerId)
  }

  return { deleteDispatch, deleteWorker, deleteWorkspace, get, insert }
}

export type DispatchSkillActivationStore = ReturnType<typeof createDispatchSkillActivationStore>
