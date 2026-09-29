import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import Database from '../../src/server/sqlite.js'

const databases: Database[] = []
const directories: string[] = []
const temporaryParent = resolve(tmpdir())

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close()
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) !== temporaryParent)
      throw new Error('Unexpected SQLite test directory')
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

const fixture = () => {
  const directory = mkdtempSync(join(temporaryParent, 'hive-sqlite-契约 '))
  directories.push(directory)
  const path = join(directory, 'state.sqlite')
  const db = new Database(path)
  databases.push(db)
  db.exec('CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT NOT NULL UNIQUE)')
  return { db, path, directory }
}

const reopen = (path: string, options = {}) => {
  const db = new Database(path, options)
  databases.push(db)
  return db
}

test('commits synchronous work and rolls back only the failed nested transaction', () => {
  const { db, path } = fixture()
  const insert = db.prepare('INSERT INTO records(value) VALUES (?)')
  const nested = db.transaction(() => {
    insert.run('rolled back inner')
    throw new Error('inner failure')
  })
  const commit = db.transaction((value: string) => {
    insert.run(value)
    expect(db.inTransaction).toBe(true)
    expect(nested).toThrow('inner failure')
    insert.run('after nested rollback')
    return 'committed'
  })
  expect(commit('outer')).toBe('committed')
  expect(db.inTransaction).toBe(false)
  db.close()
  expect(reopen(path).prepare('SELECT value FROM records ORDER BY id').all()).toEqual([
    { value: 'outer' },
    { value: 'after nested rollback' },
  ])
})

test('outer failure rolls back completed inner work and leaves the connection usable', () => {
  const { db, path } = fixture()
  const insert = db.prepare('INSERT INTO records(value) VALUES (?)')
  const nested = db.transaction(() => insert.run('inner success'))
  expect(
    db.transaction(() => {
      insert.run('outer')
      nested()
      throw new Error('outer failure')
    })
  ).toThrow('outer failure')
  expect(db.inTransaction).toBe(false)
  expect(reopen(path).prepare('SELECT value FROM records').all()).toEqual([])
  expect(insert.run('recovered')).toMatchObject({ changes: 1, lastInsertRowid: 1 })
  expect(db.prepare('SELECT value FROM records').get()).toEqual({ value: 'recovered' })
})

test('rejects async callbacks before running them and rolls back returned promises', () => {
  const { db } = fixture()
  const insert = db.prepare('INSERT INTO records(value) VALUES (?)')
  expect(() =>
    db.transaction(async () => {
      insert.run('async callback must not run')
    })()
  ).toThrow(/async|promise|synchronous/i)
  expect(() =>
    db.transaction(() => {
      insert.run('promise result must roll back')
      return Promise.resolve('later')
    })()
  ).toThrow(/async|promise|synchronous/i)
  expect(db.prepare('SELECT value FROM records').all()).toEqual([])
  expect(db.inTransaction).toBe(false)
  insert.run('after async rejection')
  expect(db.prepare('SELECT value FROM records').get()).toEqual({ value: 'after async rejection' })
})

test('reports real writer contention and permits the next write after commit', () => {
  const { db, path } = fixture()
  const other = reopen(path, { timeout: 10 })
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  expect(db.pragma('busy_timeout', { simple: true })).toBe(5000)
  db.transaction(() => {
    db.prepare('INSERT INTO records(value) VALUES (?)').run('first writer')
    expect(() =>
      other.prepare('INSERT INTO records(value) VALUES (?)').run('blocked writer')
    ).toThrowError(expect.objectContaining({ code: 'SQLITE_BUSY' }))
    expect(other.prepare('SELECT value FROM records').all()).toEqual([])
  }).immediate()
  expect(other.prepare('INSERT INTO records(value) VALUES (?)').run('second writer')).toEqual({
    changes: 1,
    lastInsertRowid: 2,
  })
  expect(db.prepare('SELECT value FROM records ORDER BY id').all()).toEqual([
    { value: 'first writer' },
    { value: 'second writer' },
  ])
})

test('readonly and missing-file opens preserve file contents and close invalidates old statements', () => {
  const { db, path, directory } = fixture()
  db.prepare('INSERT INTO records(value) VALUES (?)').run('preserved')
  const statement = db.prepare('SELECT value FROM records')
  db.close()
  expect(db.open).toBe(false)
  expect(() => statement.get()).toThrow(/closed|not open/i)
  const reader = reopen(path, { readonly: true, fileMustExist: true })
  expect(reader.prepare('SELECT value FROM records').all()).toEqual([{ value: 'preserved' }])
  expect(() =>
    reader.prepare('INSERT INTO records(value) VALUES (?)').run('forbidden')
  ).toThrowError(expect.objectContaining({ code: 'SQLITE_READONLY' }))
  const missing = join(directory, 'missing.sqlite')
  expect(() => new Database(missing, { fileMustExist: true })).toThrowError(
    expect.objectContaining({ code: 'SQLITE_CANTOPEN' })
  )
  expect(() => new Database(missing, { readonly: true })).toThrowError(
    expect.objectContaining({ code: 'SQLITE_CANTOPEN' })
  )
  expect(existsSync(missing)).toBe(false)
  expect(reopen(path).prepare('SELECT value FROM records').all()).toEqual([{ value: 'preserved' }])
})

test('binds positional and array values with legacy null, bigint, blob and plain-row behavior', () => {
  const { db } = fixture()
  db.exec(
    'CREATE TABLE bindings(id INTEGER PRIMARY KEY, label TEXT, empty TEXT, missing TEXT, quantity INTEGER, payload BLOB)'
  )
  const insert = db.prepare(
    'INSERT INTO bindings(label,empty,missing,quantity,payload) VALUES(?,?,?,?,?)'
  )
  expect(insert.run('中文', null, undefined, 9007199254740993n, Buffer.from([0, 1, 255]))).toEqual({
    changes: 1,
    lastInsertRowid: 1,
  })
  expect(insert.run(['array', undefined, null, 8n, Buffer.alloc(0)])).toEqual({
    changes: 1,
    lastInsertRowid: 2,
  })
  const row = db.prepare('SELECT * FROM bindings WHERE id = ?').get(1)
  expect(row).toStrictEqual({
    id: 1,
    label: '中文',
    empty: null,
    missing: null,
    quantity: 9007199254740992,
    payload: Buffer.from([0, 1, 255]),
  })
  expect(Object.getPrototypeOf(row)).toBe(Object.prototype)
  expect([...db.prepare('SELECT quantity FROM bindings ORDER BY id').iterate()]).toEqual([
    { quantity: 9007199254740992 },
    { quantity: 8 },
  ])
  expect(db.prepare('SELECT * FROM bindings WHERE id = ?').get(99)).toBeUndefined()
  expect(db.prepare('SELECT * FROM bindings WHERE id = ?').all(99)).toEqual([])
})

test('binds named and mixed arguments while rejecting missing, excess and invalid parameters', () => {
  const { db } = fixture()
  const named = db.prepare(
    "SELECT @label AS label, :empty AS empty, ':ignored' AS literal, ? AS amount -- @comment"
  )
  expect(named.get({ label: '命名参数', empty: undefined, unused: 'ignored' }, 3)).toEqual({
    label: '命名参数',
    empty: null,
    literal: ':ignored',
    amount: 3,
  })
  expect(() => named.get({ label: 'missing null' }, 3)).toThrow(/missing named parameter/i)
  const positional = db.prepare('INSERT INTO records(value) VALUES (?)')
  expect(() => positional.run()).toThrow(/too few/i)
  expect(() => positional.run('one', 'extra')).toThrow(/too many/i)
  expect(() => positional.run(true)).toThrow(TypeError)
  expect(db.prepare('SELECT value FROM records').all()).toEqual([])
})

test('preserves typed SQL errors and does not persist rejected constraint writes', () => {
  const { db } = fixture()
  db.exec(`
    CREATE TABLE children(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES records(id), amount INTEGER CHECK(amount > 0));
    INSERT INTO records(id,value) VALUES(1,'unique value');
    CREATE TRIGGER reject_value BEFORE INSERT ON records WHEN NEW.value='rejected'
      BEGIN SELECT RAISE(ABORT,'fixture rejected value'); END;
  `)
  for (const [sql, code] of [
    ["INSERT INTO records(value) VALUES('unique value')", 'SQLITE_CONSTRAINT_UNIQUE'],
    ['INSERT INTO records(value) VALUES(NULL)', 'SQLITE_CONSTRAINT_NOTNULL'],
    ['INSERT INTO children VALUES(1,999,1)', 'SQLITE_CONSTRAINT_FOREIGNKEY'],
    ['INSERT INTO children VALUES(1,1,0)', 'SQLITE_CONSTRAINT_CHECK'],
    ["INSERT INTO records(value) VALUES('rejected')", 'SQLITE_CONSTRAINT_TRIGGER'],
    ['SELECT * FROM missing_table', 'SQLITE_ERROR'],
  ] as const) {
    expect(() => db.exec(sql)).toThrowError(expect.objectContaining({ code }))
  }
  expect(db.prepare('SELECT value FROM records').all()).toEqual([{ value: 'unique value' }])
  expect(db.prepare('SELECT * FROM children').all()).toEqual([])
  expect(db.pragma('foreign_key_check')).toEqual([])
})

test('backs up a live WAL database into an independently reopenable file', async () => {
  const { db, directory } = fixture()
  expect(db.pragma('journal_mode = WAL', { simple: true })).toBe('wal')
  db.prepare('INSERT INTO records(value) VALUES (?)').run('committed in WAL')
  const backupPath = join(directory, 'backup.sqlite')
  await db.backup(backupPath)
  db.prepare('INSERT INTO records(value) VALUES (?)').run('after backup')
  const backup = reopen(backupPath, { readonly: true })
  expect(backup.prepare('SELECT value FROM records').all()).toEqual([{ value: 'committed in WAL' }])
  expect(backup.pragma('integrity_check', { simple: true })).toBe('ok')
})
