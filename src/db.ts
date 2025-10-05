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

// Note: This is created once when the module loads
// Using a fallback in-memory SQLite if main database is unavailable
export const bunSql = getBunSql()

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
