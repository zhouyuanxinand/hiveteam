import type { Database } from 'better-sqlite3'
import { DEFAULT_DISPATCH_TIMEOUTS } from '../shared/message-delivery.js'

/** Transport evidence supplements the existing dispatch/outbox, never rewrites historical results. */
export const applySchemaVersion52 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_deliveries (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      dispatch_id TEXT NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
      recipient_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('dispatch','report','cancel')),
      state TEXT NOT NULL CHECK(state IN ('pending','attempting','unknown','confirmed','manual','resolved')),
      evidence TEXT NOT NULL DEFAULT 'none',
      attempt INTEGER NOT NULL DEFAULT 0,
      run_id TEXT,
      session_id TEXT,
      created_at INTEGER NOT NULL,
      submitted_at INTEGER,
      confirmed_at INTEGER,
      next_attempt_at INTEGER,
      reason TEXT,
      checkpoint TEXT,
      write_started INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_message_delivery_due ON message_deliveries(state,next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_message_delivery_recipient ON message_deliveries(workspace_id,recipient_id,created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_message_delivery_inflight ON message_deliveries(workspace_id,recipient_id) WHERE state='attempting';
    CREATE TABLE IF NOT EXISTS message_delivery_events (
      id TEXT PRIMARY KEY,
      delivery_id TEXT NOT NULL REFERENCES message_deliveries(id) ON DELETE CASCADE,
      attempt INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      event TEXT NOT NULL,
      actor TEXT NOT NULL,
      reason TEXT NOT NULL,
      detail TEXT
    );
    CREATE TABLE IF NOT EXISTS dispatch_health (
      dispatch_id TEXT PRIMARY KEY REFERENCES dispatches(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL,
      started_at INTEGER,
      start_source TEXT,
      last_progress_at INTEGER,
      progress_source TEXT,
      waiting_reason TEXT,
      cancellation_requested_at INTEGER,
      cancellation_confirmed_at INTEGER,
      cancellation_source TEXT,
      reasons TEXT NOT NULL DEFAULT '[]',
      timeouts TEXT
    );
    CREATE TABLE IF NOT EXISTS dispatch_timeout_settings (
      workspace_id TEXT PRIMARY KEY,
      settings TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dispatch_timeout_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      actor TEXT NOT NULL,
      before_settings TEXT NOT NULL,
      after_settings TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dispatch_health_events (
      id TEXT PRIMARY KEY,
      dispatch_id TEXT NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      event TEXT NOT NULL,
      actor TEXT NOT NULL,
      detail TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dispatch_health_events ON dispatch_health_events(dispatch_id,created_at);
    INSERT OR IGNORE INTO message_deliveries
      (id,workspace_id,dispatch_id,recipient_id,kind,state,evidence,created_at,submitted_at,next_attempt_at,reason)
      SELECT id,workspace_id,id,to_agent_id,'dispatch',
        CASE WHEN status='queued' AND NOT EXISTS(SELECT 1 FROM dispatch_delivery_failures f WHERE f.dispatch_id=dispatches.id) THEN 'pending'
          WHEN status IN ('reported','cancelled') THEN 'resolved' ELSE 'unknown' END,
        CASE WHEN status='queued' THEN 'none' ELSE 'legacy_unknown' END,created_at,submitted_at,
        CASE WHEN status='queued' THEN created_at ELSE NULL END,'Migrated without native receipt evidence'
      FROM dispatches;
    INSERT OR IGNORE INTO message_deliveries
      (id,workspace_id,dispatch_id,recipient_id,kind,state,evidence,created_at,confirmed_at,next_attempt_at,reason,checkpoint,write_started)
      SELECT receipt_id,workspace_id,dispatch_id,target_agent_id,'report',
        CASE WHEN delivered_at IS NOT NULL THEN 'resolved' WHEN delivery_attempts=0 AND delivery_checkpoint IS NULL THEN 'pending' ELSE 'unknown' END,
        CASE WHEN delivered_at IS NULL AND delivery_attempts=0 THEN 'none' ELSE 'legacy_unknown' END,
        created_at,NULL,CASE WHEN delivery_attempts=0 THEN created_at ELSE NULL END,
        'Migrated without native receipt evidence',delivery_checkpoint,CASE WHEN delivery_attempts>0 THEN 1 ELSE 0 END
      FROM report_outbox;
    INSERT OR IGNORE INTO dispatch_health(dispatch_id,workspace_id,started_at,start_source,last_progress_at)
      SELECT id,workspace_id,submitted_at,CASE WHEN submitted_at IS NOT NULL THEN 'submission_estimate' ELSE NULL END,submitted_at FROM dispatches;
    CREATE TRIGGER IF NOT EXISTS dispatch_delivery_created AFTER INSERT ON dispatches BEGIN
      INSERT INTO message_deliveries(id,workspace_id,dispatch_id,recipient_id,kind,state,created_at,next_attempt_at)
        VALUES(NEW.id,NEW.workspace_id,NEW.id,NEW.to_agent_id,'dispatch','pending',NEW.created_at,NEW.created_at);
      INSERT INTO dispatch_health(dispatch_id,workspace_id) VALUES(NEW.id,NEW.workspace_id);
    END;
    CREATE TRIGGER IF NOT EXISTS report_delivery_created AFTER INSERT ON report_outbox BEGIN
      INSERT INTO message_deliveries(id,workspace_id,dispatch_id,recipient_id,kind,state,created_at,next_attempt_at)
        VALUES(NEW.receipt_id,NEW.workspace_id,NEW.dispatch_id,NEW.target_agent_id,'report','pending',NEW.created_at,NEW.created_at);
    END;
    CREATE TRIGGER IF NOT EXISTS report_delivery_removed AFTER DELETE ON report_outbox BEGIN
      UPDATE message_deliveries SET state='resolved',next_attempt_at=NULL,reason='Report superseded or removed' WHERE id=OLD.receipt_id;
    END;
  `)
  db.prepare(
    'UPDATE dispatch_health SET timeouts=COALESCE((SELECT settings FROM dispatch_timeout_settings WHERE workspace_id=dispatch_health.workspace_id),?) WHERE started_at IS NOT NULL AND timeouts IS NULL'
  ).run(JSON.stringify(DEFAULT_DISPATCH_TIMEOUTS))
}
