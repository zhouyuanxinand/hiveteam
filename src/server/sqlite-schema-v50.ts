import type { Database } from './sqlite.js'
import { applyResourceQueueSchema } from './sqlite-schema-resource-queue.js'

export const applySchemaVersion50 = (db: Database) => {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS resource_limits (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        max_running_total INTEGER NOT NULL CHECK(max_running_total BETWEEN 1 AND 1000),
        max_running_per_workspace INTEGER NOT NULL CHECK(max_running_per_workspace BETWEEN 1 AND 1000),
        max_workers_per_workspace INTEGER NOT NULL CHECK(max_workers_per_workspace BETWEEN 1 AND 1000),
        max_verification_per_workspace INTEGER NOT NULL CHECK(max_verification_per_workspace BETWEEN 1 AND 1000)
      );
      INSERT OR IGNORE INTO resource_limits VALUES (1, 8, 4, 12, 1);
      CREATE TABLE IF NOT EXISTS resource_limit_audit (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL CHECK(actor = 'local_user'),
        before_json TEXT NOT NULL,
        after_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS resource_reservations (
        id TEXT PRIMARY KEY,
        runtime_instance_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        execution_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('orchestrator', 'worker', 'workspace_shell', 'verification')),
        state TEXT NOT NULL CHECK(state IN ('reserved', 'spawn_pending', 'running', 'recovery_blocked', 'released')),
        agent_id TEXT,
        run_id TEXT,
        pid INTEGER,
        process_identity TEXT,
        reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        released_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS resource_execution_active
        ON resource_reservations(workspace_id, execution_key) WHERE state != 'released';
      CREATE INDEX IF NOT EXISTS resource_reservations_active
        ON resource_reservations(state, workspace_id, kind);
    `)
    applyResourceQueueSchema(db)
  })()
}
