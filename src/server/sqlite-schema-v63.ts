import type { Database } from './sqlite.js'

export const applySchemaVersion63 = (db: Database) => {
  db.exec(`CREATE TABLE IF NOT EXISTS delivery_payload_measurements (
    delivery_id TEXT NOT NULL REFERENCES message_deliveries(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL CHECK(attempt > 0),
    utf8_bytes INTEGER NOT NULL CHECK(utf8_bytes >= 0),
    prepared_at INTEGER NOT NULL,
    PRIMARY KEY(delivery_id,attempt)
  );`)
}
