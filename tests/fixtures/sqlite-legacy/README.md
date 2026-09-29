# Legacy SQLite files

These compressed SQLite files were written and closed by `better-sqlite3` 12.9.0
before the runtime driver was removed. `provenance.json` records the driver,
SQLite and Node versions, source commit, byte lengths and SHA-256 fingerprints.
All fixtures contain synthetic data; none contains a user's runtime database.

- `runtime-v59`: complete current schema, with workspace, worker, accepted report,
  stable report receipt/checkpoint and revisioned memory.
- `runtime-v4`: the historical schema shape already covered by
  `tests/server/schema-version.test.ts`, including the retired `messages.kind`
  column. It exercises the complete migration chain through version 59.
- `report-outbox-v46` and `report-outbox-v47`: focused outbox tables before and
  after receipt/checkpoint support. These are not complete runtime databases.

Tests decompress copies into temporary directories and open them using the new
runtime driver. They do not install or load the legacy driver.

To intentionally regenerate with a separately available legacy driver:

```bash
node --import tsx tests/fixtures/sqlite-legacy/generate.mjs /absolute/path/to/legacy-driver/lib/index.js
```

Use the legacy version recorded in the provenance and review changes to the
compressed files and fingerprints together. The generator uses the checked-out
schema implementation; normal verification never regenerates these files.
