import type { QueryBuilderConfig, QueryBuilderOptions, SupportedDialect } from './types'
import process from 'node:process'
import { loadConfig } from 'bunfig'

/**
 * Whether a dialect belongs to the MySQL wire-protocol family (MySQL itself,
 * SingleStore, or Vitess). These share `?` placeholders, backtick identifier
 * quoting, `ON DUPLICATE KEY UPDATE` upserts, `LAST_INSERT_ID()` id recovery,
 * and the `YYYY-MM-DD HH:MM:SS` datetime literal shape. Runtime DML branches
 * should key off this helper rather than `dialect === 'mysql'` so the
 * distributed dialects inherit the same behavior; only DDL (see
 * `SingleStoreDriver` / `VitessDriver`) diverges.
 */
export function isMysqlLike(dialect: SupportedDialect = config.dialect): boolean {
  return dialect === 'mysql' || dialect === 'singlestore' || dialect === 'vitess'
}

export const defaultConfig: QueryBuilderConfig = {
  verbose: true,
  snapshotDir: '.qb',
  migrationDir: 'database/migrations',
  dialect: 'postgres',
  database: {
    database: 'test_db',
    username: 'postgres',
    password: 'postgres',
    host: 'localhost',
    port: 5432,
  },
  vitess: {
    sharded: true,
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

/**
 * Keys a merge must never write.
 *
 * `Object.assign` and plain property assignment both go through [[Set]], so
 * writing a key literally named `__proto__` changes the target's prototype
 * instead of adding a property — and `config` lives on a `Symbol.for` key
 * shared by every copy of this module AND every version of this package in the
 * process (see the singleton comment below), so one polluted merge poisons all
 * of them. The realistic vector is not a `.ts` config file, which already
 * executes arbitrary code, but bunfig's `package.json` config section, where
 * `JSON.parse` turns `"__proto__"` into an ordinary own data property that
 * then flows through `getConfig()` into here.
 */
const FORBIDDEN_MERGE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Whether a value is a plain object the merge may recurse into.
 *
 * Deliberately narrow. `typeof null === 'object'` is the classic deep-merge
 * crash, and a class instance, `Date`, `Map` or `Set` would be silently
 * dismantled into a bag of its own enumerable properties. Anything that is not
 * `{}`-literal-shaped is a LEAF and gets assigned wholesale.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Recursively merge `source` over `target`, returning a NEW object. Neither
 * argument is mutated.
 *
 * The semantics below are load-bearing — each is pinned by a test or by a
 * documented promise, so do not "simplify" them:
 *
 *  - ARRAYS REPLACE. They do not concatenate or union. `SqliteConfig.pragmas`
 *    says so in its own doc comment, and `sqlite-bootstrap-pragmas.test.ts`
 *    asserts it by checking that `foreign_keys` is still 0 after an override
 *    that omits it — concatenation would flip that to 1.
 *    `transactionDefaults.sqlStates` is the same shape: a user narrowing
 *    retries to `['40002']` must stop retrying on `40001`, not keep it.
 *
 *  - FUNCTIONS REPLACE. `isPlainObject` rejects them, so `QueryHooks` members
 *    and `BrowserConfig.getToken` / `transformResponse` stay opaque leaves. We
 *    never recurse into a function's own enumerable properties.
 *
 *  - AN EXPLICIT `undefined` ASSIGNS; AN ABSENT KEY DOES NOT. The rule is
 *    PRESENCE, not value — `Object.keys(source)` contains a key written as
 *    `undefined` and does not contain one that was never written. Not a style
 *    choice: `resolve-dialect.test.ts` calls `setConfig({ dialect: undefined })`
 *    and expects `resolveDialect()` to fall back to `'postgres'`, and
 *    `sqlite-bootstrap-pragmas.test.ts` uses `sqlite: undefined` as the restore
 *    that un-does a pragma override for the rest of a shared-process run.
 *    Skipping `undefined` breaks both, and now that `hooks` deep-merges, an
 *    explicit `undefined` is also the only way to REMOVE a hook.
 *
 *  - `null` ASSIGNS and is never recursed into. No field in
 *    `QueryBuilderConfig` is nullable, so a `null` arriving here is a caller
 *    mistake; assigning it surfaces that at the read site instead of hiding it.
 *
 * Arrays are copied by REFERENCE, being leaves — `config.transactionDefaults
 * .sqlStates` is the same array as `defaultConfig`'s until something replaces
 * it. Nothing in `src/` mutates a config array in place (the only read is an
 * `.includes`), and cloning on every merge is not worth paying for that.
 *
 * `seen` is the chain of source objects currently being merged, so a source
 * that points back at one of its own ancestors is treated as a leaf instead of
 * recursed into. An embedding framework's config slice — the case this type
 * exists to serve — routinely carries a parent back-pointer, and it typechecks
 * fine because an optional field of an interface can be that interface. Without
 * the guard that input spins for seconds, allocates gigabytes and dies with a
 * stack overflow. It is a DEPTH chain, pushed and popped around the recursion,
 * not a global set: the same object legitimately appearing under two different
 * keys must merge both times, and a global set would silently drop the second.
 */
function mergeObject(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  seen: Set<object> = new Set(),
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target }
  seen.add(source)

  for (const key of Object.keys(source)) {
    if (FORBIDDEN_MERGE_KEYS.has(key))
      continue

    const next = source[key]
    if (isPlainObject(next) && !seen.has(next)) {
      const prev = out[key]
      // When `prev` is not itself a mergeable object there is nothing to merge
      // into, but we still recurse rather than storing the caller's literal by
      // reference — otherwise a caller who mutates their own object later would
      // be reaching into the live config.
      out[key] = mergeObject(isPlainObject(prev) ? prev : {}, next, seen)
    }
    else {
      out[key] = next
    }
  }

  seen.delete(source)
  return out
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
//  - Seeded through `mergeObject`, not `{ ...defaultConfig }`. A shallow spread
//    left `config.debug === defaultConfig.debug`, so the direct writes this
//    package makes to the live config — `config.debug.captureText = true` in
//    `actions/sql.ts` and `computeSqlText()` — were reaching into the exported
//    DEFAULTS and permanently changing them. `mergeObject` clones every plain
//    object node, which closes that.
const CONFIG_SINGLETON_KEY = Symbol.for('bun-query-builder.config')
export const config: QueryBuilderConfig
  = ((globalThis as any)[CONFIG_SINGLETON_KEY] ??= mergeObject({}, defaultConfig as unknown as Record<string, unknown>) as unknown as QueryBuilderConfig)

/**
 * Config-precedence bookkeeping, on `globalThis` for the same reason `config`
 * is: an embedding framework's build often INLINES this module, so a process
 * can hold several copies that all mutate the one shared `config`. Module-local
 * state would then be per-copy — copy A's `setConfig()` would be invisible to
 * copy B's `getConfig()`, and copy B would overwrite A's values from the config
 * file. That is exactly the bug this bookkeeping exists to prevent, so it has
 * to be as shared as the object it guards.
 *
 *  - `explicit`: top-level keys passed to `setConfig()`.
 *  - `fileLoaded`: whether the config file has been read, so it is applied
 *    once per process rather than once per inlined copy.
 *
 * The veto is deliberately WHOLE-SECTION, not per-leaf, even though
 * `QueryBuilderOptions` now makes `setConfig({ database: { host } })` the
 * normal idiom. Per-leaf looks more precise and is wrong: the fields of a
 * section are not always independent settings. `database.url` and the discrete
 * `database.host`/`port`/`username`/`password` are two mutually exclusive
 * SPELLINGS of one setting — `createConnectionString()` returns `url` verbatim
 * and never reads the others — so letting a config file's `url` survive
 * because the embedder "only named host" hands the app a connection to a
 * different database than the one it asked for, silently. Vetoing the section
 * an embedder has spoken for keeps the two spellings from being mixed across
 * sources.
 */
const CONFIG_STATE_KEY = Symbol.for('bun-query-builder.config-state')
interface ConfigState { explicit: Set<string>, fileLoaded: boolean }
const configState: ConfigState
  = ((globalThis as any)[CONFIG_STATE_KEY] ??= { explicit: new Set<string>(), fileLoaded: false })

/**
 * The dialect a command should operate on.
 *
 * `explicit` is what the user asked for on the command line — only honoured
 * when they actually said something. Every CLI command used to declare
 * `--dialect` with `{ default: 'postgres' }` and pass the result straight
 * through, so the "default" arrived as an explicit choice and beat the
 * project's own configuration: a SQLite app running `qb migrate` generated
 * Postgres DDL, and `db:wipe` looked for `pg_tables`, unless every single
 * invocation repeated `--dialect sqlite`. The fallbacks the actions already
 * carried were unreachable.
 */
export function resolveDialect(explicit?: string | null): SupportedDialect {
  if (explicit)
    return explicit as SupportedDialect
  const fromEnv = process.env.DB_DIALECT || process.env.DB_CONNECTION
  if (fromEnv)
    return fromEnv as SupportedDialect
  return (config.dialect || 'postgres') as SupportedDialect
}

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
 * Precedence is `defaults < config file < setConfig()`. bunfig returns a fully
 * populated object (defaults merged with the file and env), which is fine for
 * every key the caller has not spoken for — re-applying a default on top of the
 * singleton that already holds that default is a no-op. It is NOT fine for keys
 * an embedder set through `setConfig()`: those came back as library defaults and
 * silently overwrote the embedder's choice. `setConfig({ snapshotDir })`
 * followed by a `generateMigration()` (which calls this) reverted the snapshot
 * to `.qb` and wrote generated state into the project root.
 *
 * So the loaded object is applied with those keys filtered out — an explicit API
 * call is a stronger signal than a file that may not know the embedder exists.
 * The filter is per top-level section; see `configState` for why per-leaf is
 * the wrong granularity.
 *
 * Note the load MUST pass `defaultConfig`: bunfig derives the environment
 * variable names it recognises (`QUERY_BUILDER_*`) from the shape of the
 * defaults, so passing an empty object silently drops env-var support.
 */
export async function getConfig(): Promise<QueryBuilderConfig> {
  if (!configState.fileLoaded) {
    configState.fileLoaded = true

    const loaded = await loadConfig({
      name: 'query-builder',
      alias: 'qb',
      defaultConfig,
    })

    const applicable: QueryBuilderOptions = {}
    for (const [key, value] of Object.entries(loaded ?? {})) {
      if (!configState.explicit.has(key))
        (applicable as Record<string, unknown>)[key] = value
    }

    applyConfig(applicable)
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
 * Merge a partial config into the process-wide singleton.
 *
 * Shared by `setConfig()` (explicit, records precedence) and `getConfig()`
 * (from a file, does not) so the two paths can never drift on how nested
 * objects merge.
 *
 * This used to be `Object.assign(config, userConfig)` plus five hand-written
 * nested spreads — `database`, `timestamps`, `pagination`, `softDeletes`,
 * `vitess`. The other nine object-valued sections (`aliasing`, `relations`,
 * `transactionDefaults`, `sql`, `sqlite`, `features`, `debug`, `hooks`,
 * `browser`) were REPLACED wholesale, as were `database.pool` and
 * `transactionDefaults.backoff` one level further down. That was survivable
 * only because the parameter was `Partial<QueryBuilderConfig>`, which forced a
 * caller who wanted to change one nested field to hand over a complete
 * sub-object: the accident of an over-strict type was standing in for a merge
 * that did not exist. Now that the parameter is `QueryBuilderOptions` and
 * `setConfig({ transactionDefaults: { retries: 5 } })` is the intended idiom,
 * the merge has to be real — otherwise the type fix would have traded a
 * compile error for `config.transactionDefaults.backoff` being `undefined` at
 * runtime, which is strictly worse.
 *
 * Two mutation rules, both required:
 *
 *  1. THE TOP-LEVEL `config` OBJECT IDENTITY NEVER CHANGES. Never reassign
 *     `config`, never rebuild it. Bun's bundler splits a reassigned binding so
 *     that writers and readers land on different identifiers — Stacks +
 *     bun-query-builder hit exactly that, where `setConfig({dialect:'sqlite'})`
 *     looked like a no-op because consumers still saw the `postgres` default.
 *     `dist.config-singleton.test.ts` asserts the identity survives bundling.
 *     So the merged result is copied back onto `config` key by key.
 *
 *  2. NESTED NODES ARE REPLACED WITH FRESH OBJECTS, NOT MUTATED IN PLACE
 *     (`mergeObject` returns new objects at every level). Seven test files
 *     capture a nested node by reference and hand it back later to restore it
 *     — `database-name.test.ts` holds `config.database` and passes it to a
 *     later `setConfig` — and that idiom only works if the merge replaced the
 *     node rather than mutating the object they are still holding. In-place
 *     mutation would make every one of those restores a silent no-op.
 */
function applyConfig(userConfig: QueryBuilderOptions): void {
  const merged = mergeObject(
    config as unknown as Record<string, unknown>,
    userConfig as Record<string, unknown>,
  )

  const target = config as unknown as Record<string, unknown>
  for (const key of Object.keys(merged)) {
    if (FORBIDDEN_MERGE_KEYS.has(key))
      continue
    target[key] = merged[key]
  }
}

export function setConfig(userConfig: QueryBuilderOptions): void {
  // Detect cross-instance dialect conflicts and warn once. The proper
  // fix is per-instance config (stacksjs/stacks#1862 #18); this guard
  // surfaces the symptom so callers can see the shared-state problem
  // immediately instead of debugging mysteriously misdialected
  // queries later.
  if (userConfig.dialect && _lastConfiguredDialect && userConfig.dialect !== _lastConfiguredDialect) {
    const key = `${_lastConfiguredDialect}->${userConfig.dialect}`
    if (!_warnedDialectConflicts.has(key)) {
      _warnedDialectConflicts.add(key)
      // Phrased without naming the entry point: `db.configure()` routes through
      // here too, and telling that caller to go find a `setConfig` call they
      // never wrote sends them hunting for a site that does not exist.
      console.warn(
        `[query-builder] Configuring dialect '${userConfig.dialect}' overrides the previously `
        + `configured dialect '${_lastConfiguredDialect}'. `
        + `Config is process-wide (setConfig, db.configure and query-builder.config.ts all write it); `
        + `in-flight queries from the previous configuration may break. `
        + `Run conflicting connections in separate processes — see stacksjs/stacks#1862 #18.`,
      )
    }
  }
  if (userConfig.dialect) _lastConfiguredDialect = userConfig.dialect

  // Record the caller's intent BEFORE merging, so a later getConfig() knows not
  // to overwrite these from a config file.
  for (const key of Object.keys(userConfig))
    configState.explicit.add(key)

  applyConfig(userConfig)
}

/**
 * Identity helper for a typed `query-builder.config.ts`.
 *
 * It exists so that writing a config file requires no decision about which
 * type to annotate with — which is what stacksjs/bun-query-builder#1062 was
 * actually about. The only config type this package exported was
 * `QueryBuilderConfig`, the RESOLVED shape with every field required, and the
 * docs told people to import it, so downstream apps annotated their config
 * file with a type demanding `migrationDir`, `snapshotDir`, `features`,
 * `aliasing` and nine other sections they had no opinion about. Every field
 * added here afterwards was a downstream build break.
 *
 * `defineConfig` takes `QueryBuilderOptions`, so nothing is ever required, and
 * returns its argument unchanged — there is no runtime behavior here, only the
 * type and the editor completion that comes with it.
 *
 * ```ts
 * // query-builder.config.ts
 * import { defineConfig } from 'bun-query-builder'
 *
 * export default defineConfig({
 *   dialect: 'postgres',
 *   database: { database: 'my_app' },
 * })
 * ```
 */
export function defineConfig(userConfig: QueryBuilderOptions): QueryBuilderOptions {
  return userConfig
}
