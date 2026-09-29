import type { Database } from './sqlite.js'

export const applySchemaVersion60 = (db: Database) => {
  if (
    (db.pragma('table_info(dispatches)') as Array<{ name: string }>).some(
      (column) => column.name === 'message_protocol_version'
    )
  )
    return

  db.transaction(() => {
    db.exec(`
      ALTER TABLE dispatches ADD COLUMN message_protocol_version INTEGER NOT NULL DEFAULT 0
        CHECK(message_protocol_version IN (0,1));
      CREATE TABLE message_deliveries_v60 (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        dispatch_id TEXT NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
        recipient_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('dispatch','report','cancel','message')),
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
      INSERT INTO message_deliveries_v60(rowid,id,workspace_id,dispatch_id,recipient_id,kind,state,evidence,attempt,run_id,session_id,created_at,submitted_at,confirmed_at,next_attempt_at,reason,checkpoint,write_started)
        SELECT rowid,id,workspace_id,dispatch_id,recipient_id,kind,state,evidence,attempt,run_id,session_id,created_at,submitted_at,confirmed_at,next_attempt_at,reason,checkpoint,write_started FROM message_deliveries;
      CREATE TABLE message_delivery_events_v60 (
        id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL REFERENCES message_deliveries_v60(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        event TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        detail TEXT
      );
      INSERT INTO message_delivery_events_v60(rowid,id,delivery_id,attempt,created_at,event,actor,reason,detail)
        SELECT rowid,id,delivery_id,attempt,created_at,event,actor,reason,detail FROM message_delivery_events;
      DROP TRIGGER dispatch_delivery_created;
      DROP TRIGGER report_delivery_created;
      DROP TRIGGER report_delivery_removed;
      DROP TABLE message_delivery_events;
      DROP TABLE message_deliveries;
      ALTER TABLE message_deliveries_v60 RENAME TO message_deliveries;
      ALTER TABLE message_delivery_events_v60 RENAME TO message_delivery_events;
      CREATE INDEX idx_message_delivery_due ON message_deliveries(state,next_attempt_at);
      CREATE INDEX idx_message_delivery_recipient ON message_deliveries(workspace_id,recipient_id,created_at);
      CREATE UNIQUE INDEX idx_message_delivery_inflight ON message_deliveries(workspace_id,recipient_id) WHERE state='attempting';
      CREATE TRIGGER dispatch_delivery_created AFTER INSERT ON dispatches BEGIN
        INSERT INTO message_deliveries(id,workspace_id,dispatch_id,recipient_id,kind,state,created_at,next_attempt_at)
          VALUES(NEW.id,NEW.workspace_id,NEW.id,NEW.to_agent_id,'dispatch','pending',NEW.created_at,NEW.created_at);
        INSERT INTO dispatch_health(dispatch_id,workspace_id) VALUES(NEW.id,NEW.workspace_id);
      END;
      CREATE TRIGGER report_delivery_created AFTER INSERT ON report_outbox BEGIN
        INSERT INTO message_deliveries(id,workspace_id,dispatch_id,recipient_id,kind,state,created_at,next_attempt_at)
          VALUES(NEW.receipt_id,NEW.workspace_id,NEW.dispatch_id,NEW.target_agent_id,'report','pending',NEW.created_at,NEW.created_at);
      END;
      CREATE TRIGGER report_delivery_removed AFTER DELETE ON report_outbox BEGIN
        UPDATE message_deliveries SET state='resolved',next_attempt_at=NULL,reason='Report superseded or removed' WHERE id=OLD.receipt_id;
      END;
      CREATE TABLE dispatch_messages (
        id TEXT PRIMARY KEY,
        dispatch_id TEXT NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK(sequence>0),
        from_agent_id TEXT NOT NULL,
        to_agent_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('note','question','answer','progress')),
        reply_to TEXT REFERENCES dispatch_messages(id),
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(dispatch_id,sequence)
      );
    `)
  }).immediate()
}
