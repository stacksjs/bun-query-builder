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
 *
 * This is useful when you want to configure bun-query-builder from
 * your application code rather than using a config file.
 *
 * ⚠️ **Module-scoped configuration limitation**: this writes to the
 * single process-wide `config` object that every consumer
 * (`getBunSql`, `getPlaceholder`, dialect dispatch in `client.ts`,
 * etc.) reads from. **Multiple `createQueryBuilder` instances in the
 * same process all share this state** — calling
 * `setConfig({ dialect: 'postgres' })` after a previous
 * `setConfig({ dialect: 'sqlite' })` flips the dialect for both
 * builders, including in-flight queries that may have been
 * constructed under the previous dialect.
 *
 * This is fine for typical apps that pick one dialect at boot and
 * never change it. It's NOT safe for:
 *
 *   - Tests that spin up multiple `Database` instances with
 *     different drivers in parallel.
 *   - Apps that proxy to multiple back-end DBs simultaneously.
 *
 * If you hit this case, run the conflicting connections in separate
 * processes (one per dialect) or pin to a single dialect for the
 * process lifetime. A future major version will make config
 * per-instance — see stacksjs/stacks#1862 #18.
 *
 * Calling setConfig with a dialect that conflicts with a prior call
 * emits a once-per-conflict warning so the cross-contamination is
 * visible.
 */
let _lastConfiguredDialect: string | null = null
const _warnedDialectConflicts = new Set<string>()

export function setConfig(userConfig: Partial<QueryBuilderConfig>): void {
  // NEVER reassign `config` here (i.e. `config = { ...defaultConfig }`).
  // Reassigning an `export let` triggers Bun's bundler to split the
  // binding: the write goes to one identifier and every reader (e.g.
  // `getBunSql`, `getPlaceholder`) keeps reading the original. Stacks +
  // bun-query-builder hit this exact bug — `setConfig({dialect:'sqlite'})`
  // looked like a no-op because consumers still saw the `postgres`
  // default. If `config` is somehow undefined at call time, that's a
  // bundler-init failure we can't paper over here without recreating the
  // split, so let it surface instead. The module-top `let config = {
  // ...defaultConfig }` is the single source of truth.

  // Detect cross-instance dialect conflicts and warn once. The proper
  // fix is per-instance config (stacksjs/stacks#1862 #18); this guard
  // surfaces the symptom so callers can see the shared-state problem
  // immediately instead of debugging mysteriously misdialected
  // queries later.
  if (userConfig.dialect && _lastConfiguredDialect && userConfig.dialect !== _lastConfiguredDialect) {
    const key = `${_lastConfiguredDialect}->${userConfig.dialect}`
    if (!_warnedDialectConflicts.has(key)) {
      _warnedDialectConflicts.add(key)
      console.warn(
        `[query-builder] setConfig({ dialect: '${userConfig.dialect}' }) overrides a previous `
        + `setConfig({ dialect: '${_lastConfiguredDialect}' }). `
        + `Config is process-wide; in-flight queries from the previous configuration may break. `
        + `Run conflicting connections in separate processes — see stacksjs/stacks#1862 #18.`,
      )
    }
  }
  if (userConfig.dialect) _lastConfiguredDialect = userConfig.dialect

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
