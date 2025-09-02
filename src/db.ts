import type { DatabaseConfig, SupportedDialect } from './types'
import { SQL } from 'bun'
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
 */
export function getBunSql(): SQL {
  const connectionString = createConnectionString(config.dialect, config.database)

  return new SQL(connectionString)
}

// Note: This is created once when the module loads, so it may not reflect config changes
export const bunSql = getBunSql()

// Also export the SQL class for advanced usage
export { SQL } from 'bun'
