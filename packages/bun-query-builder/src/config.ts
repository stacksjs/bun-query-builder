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

// For backwards compatibility — synchronous access with default fallback.
//
// Why `let` + an explicit `Object.assign(config, defaultConfig)` instead of
// the obvious `export const config = defaultConfig`: when downstream code
// (e.g. `bunfig`, our config loader) introduces a top-level `await`, Bun's
// bundler may wrap this module's initializer in `__esm(async () => {...})`.
// Static `const x = y` exports inside such a wrapper are reassigned only
// once the async init runs, so callers that reach `setConfig(...)` before
// that init (e.g. another module's top-level `setConfig` call mid-graph)
// see `config` as `undefined` and `Object.assign(undefined, ...)` throws.
// Initializing as `let config = {...defaultConfig}` outside the wrapper, and
// having `setConfig` re-hydrate from defaults if it's somehow still empty,
// keeps the surface synchronous for every consumer regardless of how the
// module ends up bundled.
export let config: QueryBuilderConfig = { ...defaultConfig }

/**
 * Get the placeholder format for the current dialect.
 * PostgreSQL uses $1, $2, $3... while MySQL and SQLite use ?
 */
export function getPlaceholder(index: number): string {
  if (config.dialect === 'postgres') {
    return `$${index}`
  }
  // MySQL and SQLite use ? placeholders
  return '?'
}

/**
 * Generate placeholders for an array of values.
 * PostgreSQL: $1, $2, $3
 * MySQL/SQLite: ?, ?, ?
 */
export function getPlaceholders(count: number, startIndex = 1): string {
  if (config.dialect === 'postgres') {
    return Array.from({ length: count }, (_, i) => `$${startIndex + i}`).join(', ')
  }
  // MySQL and SQLite use ? placeholders
  return Array.from({ length: count }, () => '?').join(', ')
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

/**
 * Programmatically set/override the query builder configuration.
 * This is useful when you want to configure bun-query-builder from
 * your application code rather than using a config file.
 */
export function setConfig(userConfig: Partial<QueryBuilderConfig>): void {
  // Re-hydrate from defaults if a bundler deferred our module init far
  // enough that `config` never got its synchronous assignment (see the
  // long comment on `let config = ...` above). The cast through `unknown`
  // keeps TypeScript happy; the read of an arbitrary key (`as any`) keeps
  // Bun's bundler from DCE-ing the guard on the basis of `config`'s type.
  if ((config as unknown as Record<string, unknown> | undefined) === undefined
    || (config as any).dialect === undefined) {
    config = { ...defaultConfig }
  }
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
