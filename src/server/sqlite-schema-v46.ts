import type { Database } from './sqlite.js'

export const applySchemaVersion46 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_session_contexts (
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      context_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, agent_id)
    );
    CREATE TRIGGER IF NOT EXISTS delete_workspace_session_contexts
    AFTER DELETE ON workspaces BEGIN
      DELETE FROM agent_session_contexts WHERE workspace_id = OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS delete_worker_session_context
    AFTER DELETE ON workers BEGIN
      DELETE FROM agent_session_contexts WHERE workspace_id = OLD.workspace_id AND agent_id = OLD.id;
    END;
  `)
}
