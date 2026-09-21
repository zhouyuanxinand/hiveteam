import BetterSqlite3 from 'better-sqlite3'
import { expect, test } from 'vitest'
import { applySchemaVersion39 } from '../../src/server/sqlite-schema-v39.js'
import { applySchemaVersion40 } from '../../src/server/sqlite-schema-v40.js'
import { applySchemaVersion41 } from '../../src/server/sqlite-schema-v41.js'
import { applySchemaVersion51 } from '../../src/server/sqlite-schema-v51.js'

test('verification queued migration preserves accepted evidence, dependent records and foreign-key enforcement', () => {
  const db = new BetterSqlite3(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.exec(
      "CREATE TABLE workspaces(id TEXT PRIMARY KEY); CREATE TABLE workers(id TEXT PRIMARY KEY); CREATE TABLE dispatches(id TEXT PRIMARY KEY); INSERT INTO workspaces VALUES ('workspace'); INSERT INTO dispatches VALUES ('dispatch');"
    )
    applySchemaVersion39(db)
    applySchemaVersion40(db)
    applySchemaVersion41(db)
    db.prepare(
      "INSERT INTO dispatch_verifications (id,workspace_id,dispatch_id,report_revision,head_sha,command,state,started_at,ended_at,accepted_at,output,exit_code) VALUES ('passed','workspace','dispatch',2,'sha','node check.cjs','passed',1,2,3,'synthetic proof',0)"
    ).run()
    db.prepare("INSERT INTO dispatch_integrations VALUES ('passed','target-sha',4)").run()
    db.prepare(
      "INSERT INTO dispatch_pull_requests (dispatch_id,workspace_id,verification_id,head_sha,repository,branch,base_branch,state,number,updated_at) VALUES ('dispatch','workspace','passed','sha','owner/repo','worker','main','published',17,5)"
    ).run()
    const verification = db.prepare('SELECT * FROM dispatch_verifications').get()
    const integration = db.prepare('SELECT * FROM dispatch_integrations').get()
    const pullRequest = db.prepare('SELECT * FROM dispatch_pull_requests').get()
    applySchemaVersion51(db)
    expect(db.prepare('SELECT * FROM dispatch_verifications').get()).toEqual(verification)
    expect(db.prepare('SELECT * FROM dispatch_integrations').get()).toEqual(integration)
    expect(db.prepare('SELECT * FROM dispatch_pull_requests').get()).toEqual(pullRequest)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(db.pragma('foreign_key_check')).toEqual([])
    db.prepare(
      "INSERT INTO dispatch_verifications (id,workspace_id,dispatch_id,report_revision,head_sha,command,state,started_at) VALUES ('queued','workspace','dispatch',2,'sha','node check.cjs','queued',6)"
    ).run()
    expect(db.prepare("SELECT state FROM dispatch_verifications WHERE id='queued'").get()).toEqual({
      state: 'queued',
    })
    applySchemaVersion51(db)
    db.prepare("DELETE FROM dispatches WHERE id='dispatch'").run()
    expect(db.prepare('SELECT * FROM dispatch_verifications').all()).toEqual([])
    expect(db.prepare('SELECT * FROM dispatch_integrations').all()).toEqual([])
    expect(db.prepare('SELECT * FROM dispatch_pull_requests').all()).toEqual([])
  } finally {
    db.close()
  }
})
