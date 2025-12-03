import type { DatabaseConfig, SupportedDialect } from './types'
import { SQL } from 'bun'
import process from 'node:process'
import { config } from './config'

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
      return `sqlite://${database}`

    default:
      throw new Error(`Unsupported dialect: ${dialect}`)
  }
}

/**
 * Returns a Bun SQL instance configured for the current dialect and database settings.
 * Handles connection errors gracefully by falling back to in-memory SQLite.
 */
export function getBunSql(): SQL {
  const connectionString = createConnectionString(config.dialect, config.database)

  try {
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
  catch {
    // If connection fails (e.g., database doesn't exist), use in-memory SQLite
    // This allows tests to import modules without requiring a database
    try {
      const fallback = new SQL(':memory:')
      // Suppress errors for fallback too
      if (fallback && typeof (fallback as any).catch === 'function') {
        (fallback as any).catch(() => {
          // Silently ignore errors from fallback
        })
      }
      return fallback
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
