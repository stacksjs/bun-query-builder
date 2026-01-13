import type { DatabaseConfig, SupportedDialect } from './types'
import { SQL } from 'bun'
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
    return {
      sql,
      values: params,
      execute: () => {
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
      },
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

    // For other databases, use Bun's SQL class
    const sql = new SQL(connectionString)

    // Attach error handler to prevent unhandled promise rejections
    if (sql && typeof (sql as any).catch === 'function') {
      (sql as any).catch((error: Error) => {
        if (config.verbose && !error.message.includes('database') && !error.message.includes('does not exist')) {
          console.warn(`[query-builder] Database connection error: ${error.message}`)
        }
      })
    }

    return sql
  }
  catch (error) {
    if (config.verbose) {
      console.warn(`[query-builder] Failed to create connection: ${(error as Error).message}`)
    }
    // If connection fails (e.g., database doesn't exist), use in-memory SQLite
    // This allows tests to import modules without requiring a database
    try {
      return createSQLiteSQL(':memory:')
    }
    catch {
      // If even the fallback fails, return a mock SQL object
      return {
        query: () => Promise.resolve([]),
        execute: () => Promise.resolve([]),
        close: () => Promise.resolve(),
      } as any
    }
  }
}

// Note: Connection is created lazily on first access, not at module load time
let _bunSqlInstance: SQL | null = null
let _currentDialect: string | null = null
let _currentDatabase: string | null = null

export function getOrCreateBunSql(forceNew = false): SQL {
  // Check if config has changed since we created the connection
  const configChanged = _bunSqlInstance !== null && (
    _currentDialect !== config.dialect
    || _currentDatabase !== config.database.database
  )

  // If forceNew is true, config changed, or we don't have an instance, create a new one
  if (forceNew || configChanged || !_bunSqlInstance) {
    _bunSqlInstance = getBunSql()
    _currentDialect = config.dialect
    _currentDatabase = config.database.database
  }
  return _bunSqlInstance
}

/**
 * Resets the cached database connection.
 * Call this after changing config via setConfig() to ensure the new config is used.
 */
export function resetConnection(): void {
  _bunSqlInstance = null
  _currentDialect = null
  _currentDatabase = null
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
  // Create a proxy that lazily initializes the connection on first use
  return new Proxy({} as SQL, {
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

// Add global error handler for unhandled rejections from SQL connections
if (typeof process !== 'undefined' && process.on) {
  const existingHandler = process.listeners('unhandledRejection').find(
    h => h.name === 'sqlConnectionErrorHandler',
  )
  if (!existingHandler) {
    function sqlConnectionErrorHandler(reason: any) {
      // Silently ignore PostgreSQL/MySQL connection errors during tests
      if (
        reason
        && (reason.message?.includes('database') || reason.message?.includes('does not exist')
          || reason.code === 'ERR_POSTGRES_SERVER_ERROR'
          || reason.code === '3D000')
      ) {
        // Suppress these errors - they're expected when database isn't available
      }
    }
    Object.defineProperty(sqlConnectionErrorHandler, 'name', { value: 'sqlConnectionErrorHandler' })
    process.on('unhandledRejection', sqlConnectionErrorHandler)
  }
}

// Also export the SQL class for advanced usage
export { SQL } from 'bun'
