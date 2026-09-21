import Database from 'better-sqlite3'
import { expect, test } from 'vitest'
import { applySchemaVersion26 } from '../../src/server/sqlite-schema-v26.js'
import { applySchemaVersion39 } from '../../src/server/sqlite-schema-v39.js'
import { applySchemaVersion54 } from '../../src/server/sqlite-schema-v54.js'
import { applySchemaVersion55 } from '../../src/server/sqlite-schema-v55.js'
import { applySchemaVersion56 } from '../../src/server/sqlite-schema-v56.js'
import { createVerificationStore } from '../../src/server/verification-store.js'
import { createWorkflowRunStore } from '../../src/server/workflow-run-store.js'

test('stage 06 migrations preserve legacy semantics and evidence; failed attempt persistence rolls back the run snapshot', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.exec(
      "CREATE TABLE workspaces(id TEXT PRIMARY KEY); CREATE TABLE dispatches(id TEXT PRIMARY KEY); INSERT INTO workspaces VALUES ('workspace'); INSERT INTO dispatches VALUES ('dispatch');"
    )
    applySchemaVersion26(db)
    applySchemaVersion39(db)
    const steps = JSON.stringify([
      {
        id: 'legacy',
        worker: 'Builder',
        task: 'Deliver',
        needs: [],
        status: 'completed',
        dispatchId: 'dispatch',
        artifacts: [],
        reportText: 'Manually accepted legacy report',
        error: null,
      },
    ])
    db.prepare(
      "INSERT INTO workflow_runs(id,workspace_id,workflow_id,name,definition_json,steps_json,hive_port,status,created_at,updated_at) VALUES ('run','workspace','old.json','Old','{}',?,'0','completed',1,1)"
    ).run(steps)
    db.exec(
      "INSERT INTO dispatch_verifications(id,workspace_id,dispatch_id,report_revision,head_sha,command,state,started_at,accepted_at,output) VALUES('proof','workspace','dispatch',1,'original-sha','old-command','passed',1,2,'original-output')"
    )
    for (let iteration = 0; iteration < 2; iteration++) {
      applySchemaVersion54(db)
      applySchemaVersion55(db)
      applySchemaVersion56(db)
    }
    const runs = createWorkflowRunStore(db)
    const run = runs.get('workspace', 'run')
    if (!run) throw new Error('Missing migrated workflow')
    expect(run).toMatchObject({
      status: 'completed',
      steps: [
        {
          attempt: 0,
          inputVersion: null,
          resultVersion: null,
          dependencyVersions: {},
          status: 'completed',
          dispatchId: 'dispatch',
        },
      ],
    })
    expect(run.steps[0]?.quality).toBeUndefined()
    expect(db.prepare('SELECT * FROM workflow_step_attempts').all()).toEqual([])
    expect(createVerificationStore(db).get('proof')).toMatchObject({
      state: 'passed',
      acceptedAt: 2,
      output: 'original-output',
      logBytes: 0,
    })
    expect(createVerificationStore(db).get('proof')?.profile).toBeUndefined()
    db.exec(
      "CREATE TRIGGER reject_attempt BEFORE INSERT ON workflow_step_attempts BEGIN SELECT RAISE(ABORT, 'synthetic attempt failure'); END"
    )
    expect(() =>
      runs.saveRun({
        ...run,
        steps: run.steps.map((step) => ({ ...step, attempt: 1, status: 'running' })),
      })
    ).toThrow('synthetic attempt failure')
    expect(runs.get('workspace', 'run')).toEqual(run)
    expect(db.prepare('SELECT steps_json FROM workflow_runs').get()).toEqual({ steps_json: steps })
    expect(db.prepare('SELECT * FROM workflow_step_attempts').all()).toEqual([])
    expect(db.pragma('foreign_key_check')).toEqual([])
  } finally {
    db.close()
  }
})
