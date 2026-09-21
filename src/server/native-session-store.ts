import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type {
  NativeSessionAttempt,
  NativeSessionContext,
  NativeSessionGeneration,
} from '../shared/native-session.js'
import type { SessionHarness } from '../shared/session-adapter.js'
import { NativeSessionError } from './native-session-error.js'

type GenerationRow = Omit<NativeSessionGeneration, 'context' | 'current' | 'last_error'> & {
  context_json: string
  current: number
  error_code: NonNullable<NativeSessionGeneration['last_error']>['code'] | null
  error_message: string | null
}
const decode = (row: GenerationRow): NativeSessionGeneration => ({
  id: row.id,
  workspace_id: row.workspace_id,
  agent_id: row.agent_id,
  generation: row.generation,
  harness: row.harness,
  native_id: row.native_id,
  context: JSON.parse(row.context_json),
  state: row.state,
  current: row.current === 1,
  reason: row.reason,
  created_at: row.created_at,
  updated_at: row.updated_at,
  last_error: row.error_code
    ? {
        code: row.error_code as NonNullable<NativeSessionGeneration['last_error']>['code'],
        message: row.error_message ?? '',
      }
    : null,
})

export const createNativeSessionStore = (db: Database) => {
  const current = (workspaceId: string, agentId: string) => {
    const row = db
      .prepare(
        'SELECT * FROM native_session_generations WHERE workspace_id=? AND agent_id=? AND current=1'
      )
      .get(workspaceId, agentId) as GenerationRow | undefined
    return row ? decode(row) : null
  }
  const get = (id: string) => {
    const row = db.prepare('SELECT * FROM native_session_generations WHERE id=?').get(id) as
      | GenerationRow
      | undefined
    if (!row)
      throw new NativeSessionError('session_changed', 'This session generation no longer exists.')
    return decode(row)
  }
  const attempt = (id: string) => {
    const row = db.prepare('SELECT * FROM native_session_attempts WHERE id=?').get(id) as
      | NativeSessionAttempt
      | undefined
    if (!row)
      throw new NativeSessionError('session_changed', 'This session attempt no longer exists.')
    return row
  }
  const fail = (id: string, error: NativeSessionError) =>
    db.transaction(() => {
      const item = attempt(id)
      const uncertain = item.state === 'allocating'
      db.prepare(
        'UPDATE native_session_attempts SET state=?,error_code=?,error_message=?,updated_at=? WHERE id=?'
      ).run(uncertain ? 'uncertain' : 'failed', error.code, error.message, Date.now(), id)
      db.prepare(
        `UPDATE native_session_generations SET state=CASE WHEN ? THEN 'uncertain' ELSE state END,error_code=?,error_message=?,updated_at=? WHERE id=?`
      ).run(
        uncertain ? 1 : 0,
        uncertain ? 'session_allocation_uncertain' : error.code,
        error.message,
        Date.now(),
        item.generation_id
      )
    })()
  // A released reservation is the authority for process absence. Never infer it from a stale timestamp.
  const reconcile = () =>
    db.transaction(() => {
      const rows = db
        .prepare(`SELECT a.* FROM native_session_attempts a JOIN resource_reservations r ON r.id=a.reservation_id
      WHERE a.state IN ('prepared','allocating','starting','active') AND r.state='released'`)
        .all() as NativeSessionAttempt[]
      for (const row of rows) {
        if (row.state === 'allocating')
          fail(
            row.id,
            new NativeSessionError(
              'session_allocation_uncertain',
              'Allocation ended without a durable result. Inspect the native session before explicitly choosing a new generation.'
            )
          )
        else
          db.prepare(
            "UPDATE native_session_attempts SET state='closed',updated_at=? WHERE id=?"
          ).run(Date.now(), row.id)
      }
    })()
  const assertInactive = (generationId: string) => {
    reconcile()
    const writer = db
      .prepare(`SELECT 1 FROM native_session_attempts a LEFT JOIN resource_reservations r ON r.id=a.reservation_id
      WHERE a.generation_id=? AND (a.state IN ('prepared','allocating','starting','active') OR r.state != 'released') LIMIT 1`)
      .get(generationId)
    if (writer)
      throw new NativeSessionError(
        'session_occupied',
        'This session still has an active or unconfirmed execution. Stop it and confirm resource recovery first.'
      )
  }
  const create = (
    workspaceId: string,
    agentId: string,
    harness: SessionHarness,
    context: NativeSessionContext,
    reason: string
  ) => {
    const generation =
      (
        db
          .prepare(
            'SELECT MAX(generation) AS value FROM native_session_generations WHERE workspace_id=? AND agent_id=?'
          )
          .get(workspaceId, agentId) as { value: number | null }
      ).value ?? 0
    const id = randomUUID(),
      now = Date.now()
    db.prepare(
      'UPDATE native_session_generations SET current=0 WHERE workspace_id=? AND agent_id=?'
    ).run(workspaceId, agentId)
    db.prepare(`INSERT INTO native_session_generations(id,workspace_id,agent_id,generation,harness,native_id,storage_root,context_json,state,current,reason,created_at,updated_at)
      VALUES(?,?,?,?,?,NULL,?,?,'pending',1,?,?,?)`).run(
      id,
      workspaceId,
      agentId,
      generation + 1,
      harness,
      context.storage_root,
      JSON.stringify(context),
      reason,
      now,
      now
    )
    db.prepare('DELETE FROM agent_sessions WHERE workspace_id=? AND agent_id=?').run(
      workspaceId,
      agentId
    )
    db.prepare('UPDATE workers SET last_session_id=NULL WHERE workspace_id=? AND id=?').run(
      workspaceId,
      agentId
    )
    return get(id)
  }
  const assertUniqueIdentity = (
    harness: SessionHarness,
    storageRoot: string,
    nativeId: string,
    ownId = ''
  ) => {
    if (
      db
        .prepare(
          'SELECT 1 FROM native_session_generations WHERE harness=? AND storage_root=? AND native_id=? AND id<>?'
        )
        .get(harness, storageRoot, nativeId, ownId)
    )
      throw new NativeSessionError(
        'session_occupied',
        'This native ID is already bound to another generation. It cannot be reused.'
      )
  }
  return {
    current,
    get,
    attempt,
    fail,
    reconcile,
    assertInactive,
    adoptLegacy: (
      workspaceId: string,
      agentId: string,
      harness: SessionHarness,
      context: NativeSessionContext
    ) =>
      db.transaction(() => {
        const existing = current(workspaceId, agentId)
        if (existing) return existing
        const legacy = db
          .prepare('SELECT last_session_id FROM agent_sessions WHERE workspace_id=? AND agent_id=?')
          .get(workspaceId, agentId) as { last_session_id: string } | undefined
        if (!legacy) return null
        assertUniqueIdentity(harness, context.storage_root, legacy.last_session_id)
        const uncertainContext = { ...context, adapter_revision: 'legacy_unverified' }
        const generation = create(
          workspaceId,
          agentId,
          harness,
          uncertainContext,
          'Imported existing native ID; environment confirmation required'
        )
        db.prepare(
          "UPDATE native_session_generations SET native_id=?,state='bound',error_code='session_environment_mismatch',error_message='Confirm the environment of this imported native session before resuming.' WHERE id=?"
        ).run(legacy.last_session_id, generation.id)
        db.prepare(
          'INSERT INTO agent_sessions(workspace_id,agent_id,last_session_id,updated_at) VALUES(?,?,?,?)'
        ).run(workspaceId, agentId, legacy.last_session_id, Date.now())
        db.prepare('UPDATE workers SET last_session_id=? WHERE workspace_id=? AND id=?').run(
          legacy.last_session_id,
          workspaceId,
          agentId
        )
        return get(generation.id)
      })(),
    history: (workspaceId: string, agentId: string) =>
      (
        db
          .prepare(
            'SELECT * FROM native_session_generations WHERE workspace_id=? AND agent_id=? ORDER BY generation DESC'
          )
          .all(workspaceId, agentId) as GenerationRow[]
      ).map(decode),
    attempts: (generationId: string) =>
      db
        .prepare(
          'SELECT * FROM native_session_attempts WHERE generation_id=? ORDER BY created_at DESC LIMIT 30'
        )
        .all(generationId) as NativeSessionAttempt[],
    begin: (input: {
      workspaceId: string
      agentId: string
      harness: SessionHarness
      context: NativeSessionContext
      reservationId: string
    }) =>
      db.transaction(() => {
        reconcile()
        const item =
          current(input.workspaceId, input.agentId) ??
          create(
            input.workspaceId,
            input.agentId,
            input.harness,
            input.context,
            'Initial native session'
          )
        assertInactive(item.id)
        if (item.state === 'uncertain')
          throw new NativeSessionError(
            'session_allocation_uncertain',
            'The prior allocation result is unknown. Choose a new generation explicitly after inspecting it.'
          )
        if (
          item.harness !== input.harness ||
          JSON.stringify(item.context) !== JSON.stringify(input.context)
        )
          throw new NativeSessionError(
            'session_environment_mismatch',
            'Session cwd, platform, native storage, CLI, or execution policy changed. Review and explicitly rebind the environment.'
          )
        const id = randomUUID(),
          now = Date.now()
        db.prepare(
          `INSERT INTO native_session_attempts(id,generation_id,operation,state,reservation_id,created_at,updated_at) VALUES(?,?,?,'prepared',?,?,?)`
        ).run(id, item.id, item.native_id ? 'resume' : 'allocate', input.reservationId, now, now)
        return { generation: item, attempt: attempt(id) }
      })(),
    allocating(id: string) {
      if (attempt(id).state !== 'prepared')
        throw new NativeSessionError('session_changed', 'Allocation is no longer prepared.')
      db.prepare(
        "UPDATE native_session_attempts SET state='allocating',updated_at=? WHERE id=?"
      ).run(Date.now(), id)
    },
    bind: (id: string, nativeId: string) =>
      db.transaction(() => {
        const item = attempt(id),
          generation = get(item.generation_id)
        if (item.state !== 'allocating' || generation.native_id)
          throw new NativeSessionError(
            'session_changed',
            'This allocation cannot replace an existing binding.'
          )
        const other = db
          .prepare(
            'SELECT id FROM native_session_generations WHERE harness=? AND storage_root=? AND native_id=?'
          )
          .get(generation.harness, generation.context.storage_root, nativeId)
        if (other)
          throw new NativeSessionError(
            'session_occupied',
            'This native ID is already bound to another generation. It cannot be reused.'
          )
        const now = Date.now()
        db.prepare(
          "UPDATE native_session_generations SET native_id=?,state='bound',error_code=NULL,error_message=NULL,updated_at=? WHERE id=?"
        ).run(nativeId, now, generation.id)
        db.prepare(
          `INSERT INTO agent_sessions(agent_id,workspace_id,last_session_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(workspace_id,agent_id) DO UPDATE SET last_session_id=excluded.last_session_id,updated_at=excluded.updated_at`
        ).run(generation.agent_id, generation.workspace_id, nativeId, now)
        db.prepare('UPDATE workers SET last_session_id=? WHERE workspace_id=? AND id=?').run(
          nativeId,
          generation.workspace_id,
          generation.agent_id
        )
        db.prepare(
          "UPDATE native_session_attempts SET state='prepared',updated_at=? WHERE id=?"
        ).run(now, id)
        return get(generation.id)
      })(),
    starting(id: string) {
      if (attempt(id).state !== 'prepared')
        throw new NativeSessionError('session_changed', 'This session is no longer prepared.')
      db.prepare("UPDATE native_session_attempts SET state='starting',updated_at=? WHERE id=?").run(
        Date.now(),
        id
      )
    },
    activate: (id: string, runId: string) =>
      db.transaction(() => {
        const item = attempt(id)
        if (item.state !== 'starting')
          throw new NativeSessionError(
            'session_changed',
            'This session stopped before identity verification completed.'
          )
        db.prepare(
          "UPDATE native_session_attempts SET state='active',run_id=?,updated_at=? WHERE id=?"
        ).run(runId, Date.now(), id)
        db.prepare(
          'UPDATE native_session_generations SET error_code=NULL,error_message=NULL,updated_at=? WHERE id=?'
        ).run(Date.now(), item.generation_id)
      })(),
    close(id: string) {
      db.prepare(
        "UPDATE native_session_attempts SET state='closed',updated_at=? WHERE id=? AND state IN ('starting','active')"
      ).run(Date.now(), id)
    },
    newGeneration: (
      workspaceId: string,
      agentId: string,
      expectedId: string,
      reason: string,
      harness?: SessionHarness,
      context?: NativeSessionContext
    ) =>
      db.transaction(() => {
        const item = current(workspaceId, agentId)
        if (!item || item.id !== expectedId)
          throw new NativeSessionError(
            'session_changed',
            'The current generation changed. Refresh before choosing a new session.'
          )
        assertInactive(item.id)
        return create(
          workspaceId,
          agentId,
          harness ?? item.harness,
          context ?? item.context,
          reason
        )
      })(),
    rebind: (
      workspaceId: string,
      agentId: string,
      expectedId: string,
      context: NativeSessionContext,
      reason: string
    ) =>
      db.transaction(() => {
        const item = current(workspaceId, agentId)
        if (!item || item.id !== expectedId)
          throw new NativeSessionError(
            'session_changed',
            'The current generation changed. Refresh before rebinding.'
          )
        assertInactive(item.id)
        if (item.native_id)
          assertUniqueIdentity(item.harness, context.storage_root, item.native_id, item.id)
        db.prepare(
          'INSERT INTO native_session_context_events(id,generation_id,before_json,after_json,reason,created_at) VALUES(?,?,?,?,?,?)'
        ).run(
          randomUUID(),
          item.id,
          JSON.stringify(item.context),
          JSON.stringify(context),
          reason,
          Date.now()
        )
        db.prepare(
          'UPDATE native_session_generations SET context_json=?,storage_root=?,error_code=NULL,error_message=NULL,updated_at=? WHERE id=?'
        ).run(JSON.stringify(context), context.storage_root, Date.now(), item.id)
        return get(item.id)
      })(),
  }
}
export type NativeSessionStore = ReturnType<typeof createNativeSessionStore>
