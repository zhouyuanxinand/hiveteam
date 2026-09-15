import Database from 'better-sqlite3'
import { expect, test } from 'vitest'
import { applySchemaVersion44 } from '../../src/server/sqlite-schema-v44.js'

test('legacy receipts keep their Orchestrator recipient and subsequent migrations preserve member recipients', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`CREATE TABLE workspace_review_submissions (workspace_id TEXT, request_id TEXT, payload TEXT);
      INSERT INTO workspace_review_submissions VALUES ('w1', 'legacy', 'original answer');`)
    applySchemaVersion44(db)
    expect(db.prepare('SELECT * FROM workspace_review_submissions').get()).toEqual({
      workspace_id: 'w1',
      request_id: 'legacy',
      payload: 'original answer',
      agent_id: 'w1:orchestrator',
    })
    db.prepare('INSERT INTO workspace_review_submissions VALUES (?, ?, ?, ?)').run(
      'w1',
      'member',
      'private answer',
      'worker-1'
    )
    applySchemaVersion44(db)
    expect(
      db
        .prepare('SELECT agent_id, payload FROM workspace_review_submissions WHERE request_id = ?')
        .get('member')
    ).toEqual({ agent_id: 'worker-1', payload: 'private answer' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM workspace_review_submissions').get()).toEqual({
      count: 2,
    })
  } finally {
    db.close()
  }
})
