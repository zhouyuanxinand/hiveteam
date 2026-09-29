import { randomUUID } from 'node:crypto'
import type { createAttentionFixture } from './attention-fixture.js'

// Deterministic durable events exercise the real SQL projection and HTTP API.
export const seedCollaborationStats = (f: Awaited<ReturnType<typeof createAttentionFixture>>) => {
  const base = Date.now() - 60_000
  const ids = {
    root: randomUUID(),
    review: randomUUID(),
    second: randomUUID(),
    queued: randomUUID(),
  }
  f.db.transaction(() => {
    const insert = f.db.prepare(`INSERT INTO dispatches
      (id,workspace_id,to_agent_id,text,status,created_at,submitted_at,reported_at,report_revision,root_dispatch_id,parent_dispatch_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    insert.run(
      ids.root,
      f.workspace.id,
      f.worker.id,
      'Root with rework',
      'reported',
      base,
      base + 100,
      base + 500,
      2,
      ids.root,
      null
    )
    insert.run(
      ids.review,
      f.workspace.id,
      f.worker.id,
      'Review child',
      'reported',
      base + 10,
      base + 60,
      base + 260,
      1,
      ids.root,
      ids.root
    )
    insert.run(
      ids.second,
      f.workspace.id,
      f.worker.id,
      'Second root',
      'reported',
      base + 1000,
      base + 1300,
      base + 2200,
      1,
      ids.second,
      null
    )
    insert.run(
      ids.queued,
      f.workspace.id,
      f.worker.id,
      'Queued root',
      'queued',
      base + 3000,
      null,
      null,
      0,
      ids.queued,
      null
    )
    for (const [dispatchId, attempt] of [
      [ids.root, 2],
      [ids.review, 1],
      [ids.second, 1],
    ] as const)
      f.db
        .prepare("UPDATE message_deliveries SET attempt=?,state='confirmed' WHERE id=?")
        .run(attempt, dispatchId)
    const report = f.db.prepare(`INSERT INTO message_deliveries
      (id,workspace_id,dispatch_id,recipient_id,kind,state,created_at,submitted_at,attempt)
      VALUES(?,?,?,?,'report','unknown',?,?,1)`)
    for (const [dispatchId, created, submitted] of [
      [ids.root, 200, 230],
      [ids.root, 500, 560],
      [ids.review, 260, 280],
      [ids.second, 2200, 2400],
    ] as const)
      report.run(
        randomUUID(),
        f.workspace.id,
        dispatchId,
        f.actor,
        base + created,
        base + submitted
      )
    const message = f.db.prepare(`INSERT INTO dispatch_messages
      (id,dispatch_id,sequence,from_agent_id,to_agent_id,kind,body,created_at) VALUES(?,?,?,?,?,'note','Discuss',?)`)
    message.run(randomUUID(), ids.root, 1, f.actor, f.worker.id, base + 110)
    message.run(randomUUID(), ids.review, 1, f.actor, f.worker.id, base + 70)
    message.run(randomUUID(), ids.review, 2, f.worker.id, f.actor, base + 80)
    const payload = f.db.prepare('INSERT INTO delivery_payload_measurements VALUES(?,?,?,?)')
    payload.run(ids.root, 2, 7, base + 90)
    payload.run(ids.review, 1, 2, base + 50)
    const verificationId = randomUUID()
    f.db
      .prepare(`INSERT INTO dispatch_verifications
      (id,workspace_id,dispatch_id,report_revision,head_sha,command,state,started_at,accepted_at)
      VALUES(?,?,?,2,'source','check','passed',?,?)`)
      .run(verificationId, f.workspace.id, ids.root, base + 550, base + 600)
    f.db
      .prepare('INSERT INTO dispatch_integrations VALUES(?,?,?)')
      .run(verificationId, 'target', base + 800)
    f.db.prepare('INSERT INTO integration_candidates VALUES(?,?,?,?,?)').run(
      randomUUID(),
      f.workspace.id,
      ids.second,
      JSON.stringify({
        state: 'integrated',
        accepted_at: base + 2300,
        integrated_at: base + 2800,
      }),
      base + 2250
    )
  })()
  return { ...ids, base }
}
