import type { QueryBuilderConfig } from './types'
import { loadConfig } from 'bunfig'

export const defaultConfig: QueryBuilderConfig = {
  verbose: true,
  dialect: 'postgres',
  database: {
    database: 'test_db',
    username: 'postgres',
    password: 'postgres',
    host: 'localhost',
    port: 5432,
  },
  timestamps: {
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    defaultOrderColumn: 'created_at',
  },
  pagination: {
    defaultPerPage: 25,
    cursorColumn: 'id',
  },
  aliasing: {
    relationColumnAliasFormat: 'table_column',
  },
  relations: {
    foreignKeyFormat: 'singularParent_id',
    maxDepth: 10,
    maxEagerLoad: 50,
    detectCycles: true,
  },
  transactionDefaults: {
    retries: 2,
    isolation: 'read committed',
    sqlStates: ['40001', '40P01'],
    backoff: {
      baseMs: 50,
      factor: 2,
      maxMs: 2000,
      jitter: true,
    },
  },
  sql: {
    randomFunction: 'RANDOM()',
    sharedLockSyntax: 'FOR SHARE',
    jsonContainsMode: 'operator',
  },
  features: {
    distinctOn: true,
  },
  debug: {
    captureText: true,
  },
  hooks: {},
  softDeletes: {
    enabled: false,
    column: 'deleted_at',
    defaultFilter: true,
  },
}

// Lazy-loaded config to avoid top-level await (enables bun --compile)
let _config: QueryBuilderConfig | null = null

export async function getConfig(): Promise<QueryBuilderConfig> {
  if (!_config) {
    _config = await loadConfig({
      name: 'query-builder',
      alias: 'qb',
      defaultConfig,
    })
  }
  return _config
}

// For backwards compatibility - synchronous access with default fallback
export const config: QueryBuilderConfig = defaultConfig

/**
 * Programmatically set/override the query builder configuration.
 * This is useful when you want to configure bun-query-builder from
 * your application code rather than using a config file.
 */
export function setConfig(userConfig: Partial<QueryBuilderConfig>): void {
  // Merge user config with existing config
  Object.assign(config, userConfig)

  // Handle nested objects like database, timestamps, etc.
  if (userConfig.database) {
    config.database = { ...config.database, ...userConfig.database }
  }
  if (userConfig.timestamps) {
    config.timestamps = { ...config.timestamps, ...userConfig.timestamps }
  }
  if (userConfig.pagination) {
    config.pagination = { ...config.pagination, ...userConfig.pagination }
  }
  if (userConfig.softDeletes) {
    config.softDeletes = { ...config.softDeletes, ...userConfig.softDeletes }
  }

  // Also update the cached config if it exists
  if (_config) {
    Object.assign(_config, config)
  }
}
