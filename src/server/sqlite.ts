import { existsSync } from 'node:fs'
import {
  backup,
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from 'node:sqlite'
import { types } from 'node:util'

interface DatabaseOptions {
  readonly?: boolean
  fileMustExist?: boolean
  timeout?: number
}

interface RunResult {
  changes: number
  lastInsertRowid: number
}

const primaryErrors = [
  'SQLITE_OK',
  'SQLITE_ERROR',
  'SQLITE_INTERNAL',
  'SQLITE_PERM',
  'SQLITE_ABORT',
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_NOMEM',
  'SQLITE_READONLY',
  'SQLITE_INTERRUPT',
  'SQLITE_IOERR',
  'SQLITE_CORRUPT',
  'SQLITE_NOTFOUND',
  'SQLITE_FULL',
  'SQLITE_CANTOPEN',
  'SQLITE_PROTOCOL',
  'SQLITE_EMPTY',
  'SQLITE_SCHEMA',
  'SQLITE_TOOBIG',
  'SQLITE_CONSTRAINT',
  'SQLITE_MISMATCH',
  'SQLITE_MISUSE',
  'SQLITE_NOLFS',
  'SQLITE_AUTH',
  'SQLITE_FORMAT',
  'SQLITE_RANGE',
  'SQLITE_NOTADB',
  'SQLITE_NOTICE',
  'SQLITE_WARNING',
]
const constraintErrors: Record<number, string> = {
  275: 'SQLITE_CONSTRAINT_CHECK',
  531: 'SQLITE_CONSTRAINT_COMMITHOOK',
  787: 'SQLITE_CONSTRAINT_FOREIGNKEY',
  1043: 'SQLITE_CONSTRAINT_FUNCTION',
  1299: 'SQLITE_CONSTRAINT_NOTNULL',
  1555: 'SQLITE_CONSTRAINT_PRIMARYKEY',
  1811: 'SQLITE_CONSTRAINT_TRIGGER',
  2067: 'SQLITE_CONSTRAINT_UNIQUE',
  2323: 'SQLITE_CONSTRAINT_VTAB',
  2579: 'SQLITE_CONSTRAINT_ROWID',
  2835: 'SQLITE_CONSTRAINT_PINNED',
  3091: 'SQLITE_CONSTRAINT_DATATYPE',
}

export class SqliteError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'SqliteError'
  }
}

const sqliteCall = <T>(operation: () => T): T => {
  try {
    return operation()
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ERR_SQLITE_ERROR' &&
      'errcode' in error &&
      typeof error.errcode === 'number'
    ) {
      throw new SqliteError(
        error.message,
        constraintErrors[error.errcode] ?? primaryErrors[error.errcode & 0xff] ?? 'SQLITE_ERROR',
        { cause: error }
      )
    }
    throw error
  }
}

const inputValue = (value: unknown): SQLInputValue => {
  if (value === undefined || value === null) return null
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    Buffer.isBuffer(value)
  )
    return value
  throw new TypeError('SQLite can only bind numbers, strings, bigints, buffers, and null')
}

const outputRow = (row: Record<string, SQLOutputValue>) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === 'bigint'
        ? Number(value)
        : value instanceof Uint8Array
          ? Buffer.from(value)
          : value,
    ])
  )

// node:sqlite silently binds missing values as NULL. Count the parameter forms
// used by our statements, skipping SQL strings, quoted identifiers and comments.
const parameterTokens = (sql: string) =>
  [
    ...sql.matchAll(
      /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\r\n]*|\/\*[\s\S]*?\*\/|(\?\d*|[:@$][\p{L}\p{N}_$]+)/gu
    ),
  ].flatMap((match) => (match[1] ? [match[1]] : []))

export class Statement {
  private readonly parameters: string[]
  private readonly reader: boolean

  constructor(
    private readonly database: Database,
    private readonly statement: StatementSync,
    sql: string
  ) {
    this.parameters = parameterTokens(sql)
    this.reader = statement.columns().length > 0
    // Read every SQLite integer first, then preserve the previous driver's default
    // Number conversion (including its rounding beyond Number.MAX_SAFE_INTEGER).
    statement.setReadBigInts(true)
    statement.setAllowBareNamedParameters(false)
  }

  private bindings(params: unknown[]): [Record<string, SQLInputValue>, ...SQLInputValue[]] {
    this.database.assertOpen()
    const named: Record<string, unknown> = Object.create(null)
    const positional: SQLInputValue[] = []
    for (const value of params.flat()) {
      if (
        value !== null &&
        typeof value === 'object' &&
        !Buffer.isBuffer(value) &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
      ) {
        Object.assign(named, value)
      } else positional.push(inputValue(value))
    }
    const count = this.parameters.filter((parameter) => parameter === '?').length
    if (positional.length !== count)
      throw new RangeError(
        positional.length < count
          ? 'Too few parameter values were provided'
          : 'Too many parameter values were provided'
      )
    const bound: Record<string, SQLInputValue> = Object.create(null)
    for (const parameter of this.parameters) {
      if (parameter === '?') continue
      const name = parameter.slice(1)
      if (!Object.hasOwn(named, name)) throw new RangeError(`Missing named parameter "${name}"`)
      bound[parameter] = inputValue(named[name])
    }
    return [bound, ...positional]
  }

  run(...params: unknown[]): RunResult {
    const bindings = this.bindings(params)
    const result = sqliteCall(() => this.statement.run(...bindings))
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
  }

  get(...params: unknown[]): unknown {
    const bindings = this.bindings(params)
    if (!this.reader) throw new TypeError('This statement does not return data. Use run() instead')
    const row = sqliteCall(() => this.statement.get(...bindings))
    return row === undefined ? undefined : outputRow(row)
  }

  all(...params: unknown[]): unknown[] {
    const bindings = this.bindings(params)
    if (!this.reader) throw new TypeError('This statement does not return data. Use run() instead')
    return sqliteCall(() => this.statement.all(...bindings)).map(outputRow)
  }

  *iterate(...params: unknown[]): IterableIterator<unknown> {
    const bindings = this.bindings(params)
    if (!this.reader) throw new TypeError('This statement does not return data. Use run() instead')
    const iterator = sqliteCall(() => this.statement.iterate(...bindings))
    try {
      while (true) {
        const next = sqliteCall(() => iterator.next())
        if (next.done) return
        yield outputRow(next.value)
      }
    } finally {
      if (iterator.return) sqliteCall(() => iterator.return?.())
    }
  }
}

type Transaction<Args extends unknown[], Result> = ((...args: Args) => Result) & {
  default: (...args: Args) => Result
  deferred: (...args: Args) => Result
  immediate: (...args: Args) => Result
  exclusive: (...args: Args) => Result
}

export class Database {
  private readonly connection: DatabaseSync
  private savepoint = 0

  constructor(filename: string = ':memory:', options: DatabaseOptions = {}) {
    if (options.fileMustExist && filename !== ':memory:' && !existsSync(filename)) {
      throw new SqliteError('unable to open database file', 'SQLITE_CANTOPEN')
    }
    this.connection = sqliteCall(
      () =>
        new DatabaseSync(filename, {
          readOnly: options.readonly ?? false,
          enableForeignKeyConstraints: true,
          enableDoubleQuotedStringLiterals: false,
        })
    )
    try {
      const timeout = options.timeout ?? 5000
      if (!Number.isSafeInteger(timeout) || timeout < 0)
        throw new TypeError('SQLite timeout must be a non-negative integer')
      this.connection.exec(`PRAGMA busy_timeout = ${timeout}`)
    } catch (error) {
      this.connection.close()
      throw error
    }
  }

  get open() {
    return this.connection.isOpen
  }
  get inTransaction() {
    return this.open && this.connection.isTransaction
  }

  assertOpen() {
    if (!this.open) throw new TypeError('The database connection is not open')
  }

  prepare(sql: string): Statement {
    this.assertOpen()
    return new Statement(
      this,
      sqliteCall(() => this.connection.prepare(sql)),
      sql
    )
  }

  exec(sql: string): this {
    this.assertOpen()
    sqliteCall(() => this.connection.exec(sql))
    return this
  }

  pragma(sql: string, options: { simple?: boolean } = {}): unknown {
    this.assertOpen()
    const statement = sqliteCall(() => this.connection.prepare(`PRAGMA ${sql}`))
    statement.setReadBigInts(true)
    const rows = sqliteCall(() => statement.all()).map(outputRow)
    return options.simple ? Object.values(rows[0] ?? {})[0] : rows
  }

  transaction<Args extends unknown[], Result>(
    callback: (...args: Args) => Result
  ): Transaction<Args, Result> {
    if (types.isAsyncFunction(callback))
      throw new TypeError('SQLite transactions require a synchronous callback')
    const database = this
    const wrap = (mode: 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE') =>
      function (this: unknown, ...args: Args): Result {
        const nested = database.inTransaction
        const savepoint = `hive_transaction_${++database.savepoint}`
        database.exec(nested ? `SAVEPOINT ${savepoint}` : `BEGIN ${mode}`)
        try {
          const result = callback.apply(this, args)
          if (
            result !== null &&
            (typeof result === 'object' || typeof result === 'function') &&
            'then' in result &&
            typeof result.then === 'function'
          ) {
            throw new TypeError('SQLite transactions require a synchronous callback')
          }
          database.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT')
          return result
        } catch (error) {
          if (database.inTransaction) {
            try {
              database.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK')
            } catch (rollbackError) {
              throw new AggregateError(
                [error, rollbackError],
                'SQLite transaction and rollback failed'
              )
            }
          }
          throw error
        }
      }
    const deferred = wrap('DEFERRED')
    return Object.assign(deferred, {
      default: deferred,
      deferred,
      immediate: wrap('IMMEDIATE'),
      exclusive: wrap('EXCLUSIVE'),
    })
  }

  async backup(destination: string): Promise<void> {
    this.assertOpen()
    try {
      await backup(this.connection, destination)
    } catch (error) {
      sqliteCall(() => {
        throw error
      })
    }
  }

  close(): this {
    if (this.open) sqliteCall(() => this.connection.close())
    return this
  }
}

type DatabaseConnection = Database
export declare namespace Database {
  type Database = DatabaseConnection
}

export default Database
