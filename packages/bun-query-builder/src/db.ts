import type { DatabaseConfig, PoolConfig, SupportedDialect } from './types'
import { SQL } from 'bun'

/**
 * The query object returned by `connection.unsafe(...)` / a tagged template.
 * Both Bun's native `SQL` query and our `createSQLiteSQL` wrapper satisfy this.
 * See stacksjs/bun-query-builder#1044.
 */
export interface DriverQuery {
  execute: () => Promise<any>
  values?: () => any
  raw?: () => any
  toString: () => string
  cancel?: () => void
  readonly sql?: string
  // Escape hatch: the two driver implementations expose slightly different
  // extras; the index signature keeps unknown members typed `any` (no cast)
  // while the named members above are properly typed.
  [key: string]: any
}

/** An `unsafe(...)` result: a query object that is ALSO directly awaitable. */
export type AwaitableDriverQuery = DriverQuery & PromiseLike<any>

/**
 * The shared connection surface used across the dispatch path — both the
 * `bun:sqlite` wrapper and Bun's native `SQL` satisfy it. Typing `_sql` against
 * this (instead of `any`) is what lets the ~hundreds of `(_sql as any).unsafe`
 * casts be dropped. See stacksjs/bun-query-builder#1044.
 */
export interface DriverConnection {
  /** Tagged-template form: `` sql`SELECT 1` ``. */
  (strings: TemplateStringsArray, ...values: any[]): DriverQuery
  /** Function form for raw identifiers / value helpers: `sql('col')`. */
  (value: any): any
  unsafe: (sql: string, values?: any[]) => AwaitableDriverQuery
  query?: (sql: string, params?: any[]) => any
  close?: () => Promise<void> | void
  _prepareStatement?: (sql: string) => any
  [key: string]: any
}
import { Database } from 'bun:sqlite'
import process from 'node:process'
import { config } from './config'

/**
 * SQLite wrapper that provides a SQL-like tagged template literal interface
 * using bun:sqlite's Database class for better compiled binary support.
 */
class SQLiteWrapper {
  private db: Database

  constructor(filename: string) {
    this.db = new Database(filename)
    // Enable WAL mode for better concurrency
    this.db.run('PRAGMA journal_mode = WAL')
  }

  /**
   * Execute a query with parameters and return results.
   * This mimics the SQL tagged template literal behavior.
   */
  query(sql: string, params: any[] = []): any[] {
    const stmt = this.db.prepare(sql)
    return stmt.all(...params)
  }

  /**
   * Execute a query that doesn't return results (INSERT, UPDATE, DELETE).
   */
  run(sql: string, params: any[] = []): any {
    const stmt = this.db.prepare(sql)
    return stmt.run(...params)
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close()
  }

  /**
   * Get the underlying bun:sqlite Database instance.
   */
  get database(): Database {
    return this.db
  }
}

/**
 * Creates a raw SQL identifier marker that will be interpolated directly
 */
function createRawMarker(value: string): { __raw: true, value: string, toString: () => string } {
  return {
    __raw: true,
    value,
    toString: () => value,
  }
}

/**
 * Split SQL content into individual statements, properly handling:
 * - Semicolons inside string literals (single and double quotes)
 * - SQL comments (-- single line and block comments)
 * - Empty statements
 */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let inLineComment = false
  let inBlockComment = false

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]
    const nextChar = sql[i + 1]

    // Handle line comment start
    if (!inSingleQuote && !inDoubleQuote && !inBlockComment && char === '-' && nextChar === '-') {
      inLineComment = true
      current += char
      continue
    }

    // Handle line comment end
    if (inLineComment && (char === '\n' || char === '\r')) {
      inLineComment = false
      current += char
      continue
    }

    // Handle block comment start
    if (!inSingleQuote && !inDoubleQuote && !inLineComment && char === '/' && nextChar === '*') {
      inBlockComment = true
      current += char
      continue
    }

    // Handle block comment end
    if (inBlockComment && char === '*' && nextChar === '/') {
      inBlockComment = false
      current += char + nextChar
      i++ // skip next char
      continue
    }

    // Skip if inside comment
    if (inLineComment || inBlockComment) {
      current += char
      continue
    }

    // Handle single quotes (respecting escape sequences)
    if (char === '\'' && !inDoubleQuote) {
      // Check for escaped quote ('')
      if (inSingleQuote && nextChar === '\'') {
        current += char + nextChar
        i++ // skip next char
        continue
      }
      inSingleQuote = !inSingleQuote
      current += char
      continue
    }

    // Handle double quotes
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      current += char
      continue
    }

    // Handle statement separator
    if (char === ';' && !inSingleQuote && !inDoubleQuote) {
      const trimmed = current.trim()
      if (trimmed && !trimmed.startsWith('--')) {
        statements.push(trimmed)
      }
      current = ''
      continue
    }

    current += char
  }

  // Handle last statement without trailing semicolon
  const trimmed = current.trim()
  if (trimmed && !trimmed.startsWith('--')) {
    statements.push(trimmed)
  }

  return statements
}

/**
 * SQL-compatible wrapper that provides tagged template literal support
 * and returns Promise-based query objects for SQLite.
 *
 * This function creates a callable object that:
 * - Can be used as a tagged template literal: sql`SELECT * FROM users`
 * - Can be called as a function for raw identifiers: sql('column_name')
 * - Has methods like .unsafe(), .raw(), .close(), .query()
 */
function createSQLiteSQL(filename: string): SQL {
  const wrapper = new SQLiteWrapper(filename)

  /**
   * Process a tagged template literal and return a query object
   */
  function processTaggedTemplate(strings: TemplateStringsArray, ...values: any[]): any {
    // Build the SQL string with placeholders
    let sql = strings[0]
    const params: any[] = []

    for (let i = 0; i < values.length; i++) {
      const value = values[i]

      // Handle raw SQL markers (from sql('identifier') or sql.raw())
      if (value && typeof value === 'object' && (value.__raw || value.raw)) {
        const rawValue = value.__raw ? value.value : (typeof value.raw === 'string' ? value.raw : value.raw())
        sql += rawValue + (strings[i + 1] || '')
      }
      // Handle query objects (nested queries)
      else if (value && typeof value === 'object' && 'sql' in value && 'values' in value) {
        sql += value.sql + (strings[i + 1] || '')
        params.push(...value.values)
      }
      // Handle arrays - expand to placeholders
      else if (Array.isArray(value)) {
        const placeholders = value.map(() => '?').join(', ')
        sql += placeholders + (strings[i + 1] || '')
        params.push(...value)
      }
      // Regular value - use placeholder
      else {
        sql += `?${strings[i + 1] || ''}`
        params.push(value)
      }
    }

    // Return an object with execute() that returns a Promise
    return {
      sql,
      values: params,
      execute: () => {
        try {
          // Determine if this is a SELECT or other statement
          const trimmed = sql.trim().toUpperCase()
          if (trimmed.startsWith('SELECT') || trimmed.startsWith('PRAGMA')) {
            const result = wrapper.query(sql, params)
            return Promise.resolve(result)
          }
          else {
            const result = wrapper.run(sql, params)
            return Promise.resolve(result)
          }
        }
        catch (error) {
          return Promise.reject(error)
        }
      },
      raw: () => sql,
      toString: () => sql,
      cancel: () => {}, // No-op for SQLite
    }
  }

  /**
   * The main SQL function that handles both:
   * - Tagged template literals: sql`SELECT * FROM users`
   * - Function calls for raw identifiers: sql('column_name')
   */
  function sqlFunction(stringsOrValue: TemplateStringsArray | string, ...values: any[]): any {
    // If called with a template literal (array of strings)
    if (Array.isArray(stringsOrValue) && 'raw' in stringsOrValue) {
      return processTaggedTemplate(stringsOrValue as TemplateStringsArray, ...values)
    }

    // If called as a regular function with a string argument: sql('identifier')
    // Return a raw SQL marker that will be interpolated directly
    if (typeof stringsOrValue === 'string') {
      return createRawMarker(stringsOrValue)
    }

    // Fallback: treat as empty query
    return processTaggedTemplate([''] as unknown as TemplateStringsArray)
  }

  // Add .raw() method for creating raw SQL expressions
  sqlFunction.raw = (str: string) => createRawMarker(str)

  // Add .unsafe() method for raw SQL with parameters (like Bun's SQL.unsafe)
  sqlFunction.unsafe = (sql: string, params: any[] = []) => {
    const execute = (): Promise<any> => {
      try {
        const trimmed = sql.trim().toUpperCase()
        if (trimmed.startsWith('SELECT') || trimmed.startsWith('PRAGMA')) {
          const result = wrapper.query(sql, params)
          return Promise.resolve(result)
        }
        else {
          const result = wrapper.run(sql, params)
          return Promise.resolve(result)
        }
      }
      catch (error) {
        return Promise.reject(error)
      }
    }

    // Make the returned builder Promise/A+ conformant. Without `.then`,
    // `await db.unsafe(...)` yields the builder object itself rather
    // than the rows — diverging from Bun's native (Postgres) `sql.unsafe`,
    // which IS thenable. The documented signature `(...) => Promise<any>`
    // and the JSDoc example `const rows = await db.unsafe('SELECT 1')`
    // both assume auto-execute; aligning the SQLite path closes a
    // silent driver-skew bug. See
    // https://github.com/stacksjs/bun-query-builder/issues/1017
    return {
      sql,
      values: params,
      execute,
      then: (onFulfilled: (rows: any) => any, onRejected?: (err: any) => any) => execute().then(onFulfilled, onRejected),
      raw: () => sql,
      toString: () => sql,
      cancel: () => {},
    }
  }

  // Add .close() method
  sqlFunction.close = () => {
    wrapper.close()
    return Promise.resolve()
  }

  // Add .query() method for direct SQL execution
  sqlFunction.query = (sql: string, params?: any[]) => {
    try {
      const result = wrapper.query(sql, params || [])
      return Promise.resolve(result)
    }
    catch (error) {
      return Promise.reject(error)
    }
  }

  // Add .file() method for executing SQL from a file
  sqlFunction.file = async (filePath: string, _params?: any[]) => {
    try {
      const { readFileSync } = await import('node:fs')
      const sqlContent = readFileSync(filePath, 'utf-8')

      // Split SQL into statements, handling string literals properly
      const statements = splitSqlStatements(sqlContent)

      for (const statement of statements) {
        const trimmed = statement.trim()
        if (!trimmed || trimmed.startsWith('--')) {
          continue
        }
        const upper = trimmed.toUpperCase()
        if (upper.startsWith('SELECT') || upper.startsWith('PRAGMA')) {
          wrapper.query(statement)
        }
        else {
          wrapper.run(statement)
        }
      }

      return Promise.resolve([])
    }
    catch (error) {
      return Promise.reject(error)
    }
  }

  // Store the wrapper for access
  sqlFunction._wrapper = wrapper

  return sqlFunction as unknown as SQL
}

/**
 * Creates a database connection string based on the configured dialect and database settings.
 */
function createConnectionString(dialect: SupportedDialect, dbConfig: DatabaseConfig): string {
  // If a full URL is provided, use it directly
  if (dbConfig.url) {
    return dbConfig.url
  }

  const { database, username, password, host = 'localhost', port } = dbConfig

  switch (dialect) {
    case 'postgres':
      return `postgres://${username}:${password}@${host}${port ? `:${port}` : ''}/${database}`

    case 'mysql':
      return `mysql://${username}:${password}@${host}${port ? `:${port}` : ''}/${database}`

    case 'sqlite':
      // For SQLite, database is treated as the filename
      if (database === ':memory:') {
        return ':memory:'
      }
      // Return just the filename for bun:sqlite
      return database || ':memory:'

    default:
      throw new Error(`Unsupported dialect: ${dialect}`)
  }
}

/**
 * Map the qb-level `pool` config (ms-based, ergonomic) onto the Bun SQL
 * driver's native option names (second resolution). Only the knobs Bun's
 * `SQL` actually honors are emitted — `min`/`autoReconnect` are accepted on
 * `PoolConfig` for forward-compatibility but the driver manages them itself,
 * so they are intentionally not passed through. See
 * stacksjs/bun-query-builder#1014.
 */
export function resolvePoolOptions(pool?: PoolConfig): {
  max?: number
  idleTimeout?: number
  connectionTimeout?: number
  maxLifetime?: number
} {
  if (!pool)
    return {}
  const out: { max?: number, idleTimeout?: number, connectionTimeout?: number, maxLifetime?: number } = {}
  // Bun's pool timeouts are in seconds; convert from ms (rounded, floored at 0).
  const toSeconds = (ms: number): number => Math.max(0, Math.round(ms / 1000))
  if (typeof pool.max === 'number' && Number.isFinite(pool.max))
    out.max = pool.max
  if (typeof pool.idleTimeoutMs === 'number' && Number.isFinite(pool.idleTimeoutMs))
    out.idleTimeout = toSeconds(pool.idleTimeoutMs)
  if (typeof pool.acquireTimeoutMs === 'number' && Number.isFinite(pool.acquireTimeoutMs))
    out.connectionTimeout = toSeconds(pool.acquireTimeoutMs)
  if (typeof pool.maxLifetimeMs === 'number' && Number.isFinite(pool.maxLifetimeMs))
    out.maxLifetime = toSeconds(pool.maxLifetimeMs)
  return out
}

/**
 * Returns a Bun SQL instance configured for the current dialect and database settings.
 * For SQLite, uses bun:sqlite directly for better compiled binary support.
 * Handles connection errors gracefully by falling back to in-memory SQLite.
 */
export function getBunSql(): SQL {
  const dialect = config.dialect
  const connectionString = createConnectionString(dialect, config.database)

  try {
    // For SQLite, use our wrapper that uses bun:sqlite directly
    if (dialect === 'sqlite') {
      return createSQLiteSQL(connectionString)
    }

    // For other databases, use Bun's SQL class, threading through any
    // configured connection-pool options (#1014).
    const poolOptions = resolvePoolOptions(config.database.pool)
    const sql = Object.keys(poolOptions).length > 0
      ? new SQL(connectionString, poolOptions)
      : new SQL(connectionString)

    // NOTE: a Bun `SQL` instance is not a Promise and has no `.catch`, so the
    // previous `if (typeof sql.catch === 'function')` handler here was dead
    // code (and would have re-masked exactly the "database does not exist"
    // errors #1022 made loud). Async connection errors surface at query time
    // and via the process-level handler below. See #1039.
    return sql
  }
  catch (error) {
    // Surface the real construction failure UNCONDITIONALLY — never gate it
    // behind `verbose`. The previous silent fallback was the root of the
    // "no such table" confusion in stacksjs/bun-query-builder#1022: a
    // misconfigured Postgres/MySQL connection string (e.g. an unparseable URL
    // from un-encoded credentials/database name) was swapped for a fresh,
    // empty in-memory SQLite, so every subsequent query failed with a
    // misleading "no such table" instead of the actual connection error.
    console.error(
      `[query-builder] Failed to create database connection for dialect '${dialect}': ${(error as Error).message}`,
    )

    // Only the sqlite dialect may fall back to in-memory SQLite. For a real
    // network driver, masking the failure with an empty SQLite db hides the
    // misconfiguration and corrupts every later query (and poisons the cached
    // connection until resetConnection()). Fail loudly instead — re-throw the
    // original error so callers see the precise cause.
    if (dialect === 'sqlite') {
      return createSQLiteSQL(':memory:')
    }
    throw error
  }
}

// Note: Connection is created lazily on first access, not at module load time
let _bunSqlInstance: SQL | null = null
let _currentSignature: string | null = null

/**
 * Signature of every config field that affects the connection — so a
 * `setConfig` change to host/port/url/credentials/pool (not just dialect +
 * database name) invalidates the cached connection. Previously only
 * dialect + database.database were compared, so e.g. pointing at a new host
 * via setConfig kept the stale connection. See stacksjs/bun-query-builder#1041.
 */
function connectionSignature(): string {
  const d = config.database
  return JSON.stringify({
    dialect: config.dialect,
    database: d.database,
    username: d.username,
    password: d.password,
    host: d.host,
    port: d.port,
    url: d.url,
    pool: resolvePoolOptions(d.pool),
  })
}

export function getOrCreateBunSql(forceNew = false): SQL {
  const signature = connectionSignature()
  const configChanged = _bunSqlInstance !== null && _currentSignature !== signature

  // If forceNew is true, config changed, or we don't have an instance, create a new one
  if (forceNew || configChanged || !_bunSqlInstance) {
    _bunSqlInstance = getBunSql()
    _currentSignature = signature
  }
  return _bunSqlInstance
}

/**
 * Resets the cached database connection.
 * Call this after changing config via setConfig() to ensure the new config is used.
 */
export function resetConnection(): void {
  _bunSqlInstance = null
  _currentSignature = null
}

// Wrapper that catches "Connection closed" errors and retries with a fresh connection
export async function withFreshConnection<T>(fn: (sql: SQL) => Promise<T>): Promise<T> {
  try {
    return await fn(getOrCreateBunSql())
  }
  catch (error: any) {
    // If connection is closed, create a fresh connection and retry once
    if (error?.code === 'ERR_POSTGRES_CONNECTION_CLOSED' || error?.message?.includes('Connection closed')) {
      console.log('-- Connection closed, creating fresh connection...')
      const freshSql = getOrCreateBunSql(true)
      return await fn(freshSql)
    }
    throw error
  }
}

/**
 * Lazy SQL connection proxy - connection is only created when first accessed.
 * This allows setConfig() to be called before any database connection is made.
 */
function createLazyBunSql(): SQL {
  // Create a proxy that lazily initializes the connection on first use.
  // The target MUST be a function: per spec a Proxy is only callable when its
  // target has [[Call]], so a `{}` target makes the `apply` trap dead and
  // `bunSql`...`` / `bunSql(...)` throw "not a function" — which silently broke
  // every method built on the tagged template (upsert/insertOrIgnore/
  // insertGetId/updateOrInsert/save). See stacksjs/bun-query-builder#1035.
  // eslint-disable-next-line no-empty-function
  return new Proxy((function lazyBunSql() {}) as unknown as SQL, {
    get(_target, prop) {
      // Get or create the actual SQL instance
      const sql = getOrCreateBunSql()
      const value = (sql as any)[prop]
      // If it's a function, bind it to the sql instance
      if (typeof value === 'function') {
        return value.bind(sql)
      }
      return value
    },
    apply(_target, _thisArg, args) {
      // Handle tagged template literal calls: bunSql`SELECT ...`
      const sql = getOrCreateBunSql()
      return (sql as any)(...args)
    },
  })
}

// Export a lazy proxy - no connection is made until first use
export const bunSql: SQL = createLazyBunSql()

// NOTE: this module no longer installs a process-wide `unhandledRejection`
// handler. A library has no business doing so: ANY such listener suppresses the
// runtime's default crash for EVERY unhandled rejection in the consumer's
// process (the old handler's body matched only DB errors but silently swallowed
// the rest), masking genuine production bugs. Expected "database does not exist"
// errors during tests are surfaced/awaited at query time now (#1022); a test
// harness that needs to tolerate a missing DB should install its own handler.
// See stacksjs/bun-query-builder#1040.

// Also export the SQL class for advanced usage
export { SQL } from 'bun'
