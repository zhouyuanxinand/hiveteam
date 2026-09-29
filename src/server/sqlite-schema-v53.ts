import type { Database } from './sqlite.js'

/** Historical free-form reviews deliberately remain unqualified historical text. */
export const applySchemaVersion53 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatch_code_reviews (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      dispatch_id TEXT NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
      repository_id TEXT NOT NULL,
      source_sha TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      report_revision INTEGER NOT NULL CHECK(report_revision > 0),
      reviewer_id TEXT NOT NULL,
      reviewer_run_id TEXT,
      reviewer_policy_id TEXT,
      conclusion TEXT NOT NULL CHECK(conclusion IN ('approve','changes_requested','comment')),
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      accepted_at INTEGER,
      accepted_by TEXT,
      CHECK((accepted_at IS NULL AND accepted_by IS NULL) OR
        (accepted_at IS NOT NULL AND accepted_by = 'local_user' AND conclusion = 'approve'))
    );
    CREATE INDEX IF NOT EXISTS idx_code_reviews_dispatch
      ON dispatch_code_reviews(workspace_id, dispatch_id, created_at DESC);
  `)
}
