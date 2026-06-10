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

// The single, process-wide config object — stored on a `globalThis` symbol so
// that EVERY copy of this module shares one object, even if Bun's bundler
// inlines `config.ts` more than once. Previously this was an `export let` that
// `setConfig` mutated in place: it worked, but relied on the bundler keeping a
// never-reassigned live binding as a single shared binding, and the build had
// to regex-patch the emitted `__esm(init_config)` wrapper to keep readers and
// writers on the same binding. A `globalThis`-keyed `export const` removes both
// hazards — there is no module-local binding to split or rename, and `const`
// makes the "never reassign config" rule unenforceable-to-break.
//
// Notes:
//  - `??=` so the first-evaluated copy wins and the rest reuse it.
//  - `Symbol.for` is a process-global registry key (shared across copies). It
//    is also shared across package versions in one process — that's the intended
//    hardening; pin a versioned key if you ever need per-version isolation.
//  - Synchronous + no top-level await here, so `bun --compile` is unaffected.
const CONFIG_SINGLETON_KEY = Symbol.for('bun-query-builder.config')
export const config: QueryBuilderConfig
  = ((globalThis as any)[CONFIG_SINGLETON_KEY] ??= { ...defaultConfig })

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
  if (count <= 0)
    return ''
  if (config.dialect === 'postgres') {
    // Build `$n, $n+1, …` with a single growing string instead of
    // allocating an intermediate array + closure per call (hot path:
    // every whereIn / insert row).
    let out = `$${startIndex}`
    for (let i = 1; i < count; i++)
      out += `, $${startIndex + i}`
    return out
  }
  // MySQL and SQLite use `?` placeholders — a fixed repeat, no array.
  return count === 1 ? '?' : `?${', ?'.repeat(count - 1)}`
}

// Lazy-loaded config to avoid top-level await (enables bun --compile)
let _config: QueryBuilderConfig | null = null

/**
 * Load the query-builder config from a config file (`query-builder.config.ts`,
 * `.config/query-builder.ts`, etc.) and environment variables via bunfig, then
 * MERGE it into the live, process-wide `config` singleton so every reader
 * (dialect dispatch, placeholders, soft-deletes, the model layer, …) sees it.
 *
 * Call this once at application boot if you keep configuration in a file:
 *
 * ```ts
 * import { getConfig } from 'bun-query-builder'
 * await getConfig() // applies query-builder.config.ts + env to the runtime
 * ```
 *
 * It is intentionally explicit/async: the builder otherwise runs purely off the
 * synchronous `config` singleton (defaults + any `setConfig`), which keeps
 * `bun --compile` and test behavior deterministic — auto-loading a file in the
 * background would make early queries race the load. Previously this wrote the
 * loaded config to a private `_config` variable that nothing else read, so a
 * config file silently never took effect; it now routes through `setConfig`.
 */
export async function getConfig(): Promise<QueryBuilderConfig> {
  if (!_config) {
    _config = await loadConfig({
      name: 'query-builder',
      alias: 'qb',
      defaultConfig,
    })
    // Apply the loaded file/env config to the shared singleton so it actually
    // reaches the query builder. setConfig() handles the nested-object merges.
    setConfig(_config)
  }
  return config
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
