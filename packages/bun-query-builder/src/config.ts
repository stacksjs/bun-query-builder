import type { QueryBuilderConfig, SupportedDialect } from './types'
import { loadConfig } from 'bunfig'

/**
 * Whether a dialect belongs to the MySQL wire-protocol family (MySQL itself or
 * SingleStore). These share `?` placeholders, backtick identifier quoting,
 * `ON DUPLICATE KEY UPDATE` upserts, `LAST_INSERT_ID()` id recovery, and the
 * `YYYY-MM-DD HH:MM:SS` datetime literal shape. Runtime DML branches should key
 * off this helper rather than `dialect === 'mysql'` so SingleStore inherits the
 * same behavior; only DDL (see `SingleStoreDriver`) diverges.
 */
export function isMysqlLike(dialect: SupportedDialect = config.dialect): boolean {
  return dialect === 'mysql' || dialect === 'singlestore'
}

export const defaultConfig: QueryBuilderConfig = {
  verbose: true,
  snapshotDir: '.qb',
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

// Whether the config file has been loaded. A boolean rather than a cached
// object, because the loaded values are merged straight into the `config`
// singleton above — that singleton IS the cache.
let _fileConfigLoaded = false

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
 * background would make early queries race the load.
 *
 * Precedence is `defaults < config file < setConfig()`, and BOTH halves of that
 * matter here:
 *
 *  - The file is loaded with EMPTY defaults, so the returned object holds only
 *    the keys the file/env actually specified. Passing `defaultConfig` instead
 *    made bunfig return a fully-populated object, every key of which then
 *    overwrote the singleton — so merely calling `getConfig()` reset settings
 *    the file never mentioned back to library defaults.
 *  - Keys an embedder set explicitly via `setConfig()` are skipped, because an
 *    explicit API call is a stronger signal than a file that may not even know
 *    the embedder exists.
 *
 * Together those are what let a host framework configure the builder in its own
 * process and have it stick: `setConfig({ snapshotDir })` followed by a
 * `generateMigration()` (which calls this) used to silently revert the snapshot
 * to `.qb` and write generated state into the project root.
 */
export async function getConfig(): Promise<QueryBuilderConfig> {
  if (!_fileConfigLoaded) {
    _fileConfigLoaded = true

    const fileConfig = await loadConfig({
      name: 'query-builder',
      alias: 'qb',
      // Empty, NOT `defaultConfig` — see the precedence note above. The
      // defaults already seeded the singleton; re-applying them here would
      // clobber whatever has been configured since.
      defaultConfig: {} as Partial<QueryBuilderConfig>,
    })

    const fromFile: Partial<QueryBuilderConfig> = {}
    for (const [key, value] of Object.entries(fileConfig ?? {})) {
      if (!_explicitlySet.has(key))
        (fromFile as Record<string, unknown>)[key] = value
    }

    applyConfig(fromFile)
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

/**
 * Top-level keys an embedder has passed to `setConfig()`. `getConfig()` will
 * not overwrite these from a config file — an explicit API call outranks a file
 * that may not know the embedder exists. See the precedence note on
 * `getConfig()`.
 */
const _explicitlySet = new Set<string>()

/**
 * Merge a partial config into the process-wide singleton.
 *
 * Shared by `setConfig()` (explicit, marks keys) and `getConfig()` (from a
 * file, does not) so the two paths can never drift on how nested objects merge.
 */
function applyConfig(userConfig: Partial<QueryBuilderConfig>): void {
  // NEVER reassign `config` here (i.e. `config = { ...defaultConfig }`).
  // Reassigning an `export let` triggers Bun's bundler to split the
  // binding: the write goes to one identifier and every reader (e.g.
  // `getBunSql`, `getPlaceholder`) keeps reading the original. Stacks +
  // bun-query-builder hit this exact bug — `setConfig({dialect:'sqlite'})`
  // looked like a no-op because consumers still saw the `postgres`
  // default. If `config` is somehow undefined at call time, that's a
  // bundler-init failure we can't paper over here without recreating the
  // split, so let it surface instead. The module-top `config` singleton
  // is the single source of truth.
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
}

export function setConfig(userConfig: Partial<QueryBuilderConfig>): void {
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

  // Record the caller's intent BEFORE merging, so a later getConfig() knows not
  // to overwrite these from a config file.
  for (const key of Object.keys(userConfig))
    _explicitlySet.add(key)

  applyConfig(userConfig)
}
