/**
 * # `SupportedDialect`
 *
 * The SQL dialect used to tailor generated SQL and certain features.
 * - 'postgres': Uses `RANDOM()`, supports JSON operators (e.g. `@>`), `FOR SHARE`, `FOR UPDATE`, CTEs
 * - 'mysql': Uses `RAND()`, shared locks via `LOCK IN SHARE MODE`
 * - 'sqlite': Lightweight engine; some features are limited or emulated
 */
export type SupportedDialect = 'postgres' | 'mysql' | 'sqlite'

/**
 * # `TransactionBackoffConfig`
 *
 * Controls exponential backoff between transaction retry attempts.
 *
 * - `baseMs`: Initial delay in milliseconds used for the first retry.
 * - `factor`: Multiplicative growth factor applied per attempt (e.g., 2 = doubles).
 * - `maxMs`: Maximum delay cap in milliseconds; backoff never exceeds this value.
 * - `jitter`: When true, adds a small randomization to the delay to reduce thundering herds.
 *
 * The delay for attempt n (1-indexed) is roughly: min(maxMs, baseMs * factor^(n-1)),
 * optionally adjusted by jitter.
 */
export interface TransactionBackoffConfig {
  /** Initial delay in milliseconds for the first retry attempt. */
  baseMs: number
  /** Multiplicative growth factor per retry attempt (e.g., 2 doubles each time). */
  factor: number
  /** Maximum backoff delay cap in milliseconds. */
  maxMs: number
  /** When true, applies jitter to spread out concurrent retries. */
  jitter: boolean
}

/**
 * # `TransactionDefaultsConfig`
 *
 * Default settings applied to transactional operations.
 *
 * - `retries`: Number of times a transaction may be retried on retriable errors
 *   (e.g., deadlocks, serialization failures).
 * - `isolation`: Transaction isolation level.
 *   - 'read committed': Prevents dirty reads; non-repeatable reads possible.
 *   - 'repeatable read': Ensures stable snapshot for a transaction; phantom reads may vary by DB.
 *   - 'serializable': Highest isolation; transactions appear to run one-by-one.
 * - `sqlStates`: Additional vendor error codes considered retriable.
 * - `backoff`: Backoff configuration applied between retries.
 */
export interface TransactionDefaultsConfig {
  /** Number of retry attempts for retriable transaction errors. */
  retries: number
  /**
   * Transaction isolation level.
   * - 'read committed': Prevents dirty reads; non-repeatable reads possible
   * - 'repeatable read': Stable snapshot; phantom reads vary by DB
   * - 'serializable': Highest isolation; appears fully serialized
   */
  isolation?: 'read committed' | 'repeatable read' | 'serializable'
  /** Vendor-specific SQLSTATE codes considered retriable. */
  sqlStates: string[]
  /** Backoff configuration applied between retries. */
  backoff: TransactionBackoffConfig
}

/**
 * # `TimestampConfig`
 *
 * Column naming conventions for timestamp fields used by helpers.
 *
 * - `createdAt`: Column name for row creation time (e.g., 'created_at').
 * - `updatedAt`: Column name for last update time (e.g., 'updated_at').
 * - `defaultOrderColumn`: Column used by helpers like `latest()`/`oldest()`.
 */
export interface TimestampConfig {
  /** Column name for row creation time (e.g., 'created_at'). */
  createdAt: string
  /** Column name for last update time (e.g., 'updated_at'). */
  updatedAt: string
  /** Column used by helpers like `latest()`/`oldest()` when unspecified. */
  defaultOrderColumn: string
}

/**
 * # `PaginationConfig`
 *
 * Defaults for result pagination helpers.
 *
 * - `defaultPerPage`: Default LIMIT used by paginate helpers when not specified.
 * - `cursorColumn`: Default column used for cursor-based pagination (e.g., 'id').
 */
export interface PaginationConfig {
  /** Default LIMIT value used by paginate helpers. */
  defaultPerPage: number
  /** Default column used for cursor-based pagination (e.g., 'id'). */
  cursorColumn: string
}

/**
 * # `AliasingConfig`
 *
 * Controls how selected columns from joined relations are aliased.
 *
 * - `relationColumnAliasFormat`:
 *   - 'table_column': Aliases as `${table}_${column}` (e.g., `posts_title`).
 *   - 'table.dot.column': Aliases with dot notation (e.g., `posts.title`).
 *   - 'camelCase': Aliases as camelCase from `${table}_${column}` (e.g., `postsTitle`).
 */
export interface AliasingConfig {
  /**
   * How to alias selected relation columns.
   * - 'table_column': `${table}_${column}` (e.g., `posts_title`)
   * - 'table.dot.column': Dot notation (e.g., `posts.title`)
   * - 'camelCase': Camel-cased from `${table}_${column}` (e.g., `postsTitle`)
   */
  relationColumnAliasFormat: 'table_column' | 'table.dot.column' | 'camelCase'
}

/**
 * # `RelationsConfig`
 *
 * Conventions for inferring foreign key names and singularization.
 *
 * - `foreignKeyFormat`:
 *   - 'singularParent_id': Uses `${singular(parent)}_id` (e.g., `user_id`).
 *   - 'parentId': Uses camelCase `parentId` (e.g., `userId`).
 * - `singularizeStrategy`:
 *   - 'stripTrailingS': Naively remove trailing 's' when singularizing (default behavior when enabled elsewhere).
 *   - 'none': Do not singularize relation/table names.
 */
export interface RelationsConfig {
  /**
   * Convention for naming foreign key columns.
   * - 'singularParent_id': `${singular(parent)}_id` (e.g., `user_id`)
   * - 'parentId': CamelCase `parentId` (e.g., `userId`)
   */
  foreignKeyFormat: 'singularParent_id' | 'parentId'
  /**
   * Strategy used to singularize parent names.
   * - 'stripTrailingS': Naively remove a trailing 's'
   * - 'none': Do not singularize
   */
  singularizeStrategy?: 'stripTrailingS' | 'none'
}

/**
 * # `SqlConfig`
 *
 * Dialect-specific SQL toggles.
 *
 * - `randomFunction`:
 *   - 'RANDOM()': PostgreSQL/SQLite style function for random ordering.
 *   - 'RAND()': MySQL style function for random ordering.
 * - `sharedLockSyntax`:
 *   - 'FOR SHARE': PostgreSQL style shared lock.
 *   - 'LOCK IN SHARE MODE': MySQL style shared lock.
 * - `jsonContainsMode`:
 *   - 'operator': Use native operators when available (e.g., Postgres `@>`).
 *   - 'function': Use a function-based approach (e.g., `json_contains`) when operators are not available.
 */
export interface SqlConfig {
  /**
   * Dialect function used for random ordering.
   * - 'RANDOM()': PostgreSQL/SQLite style
   * - 'RAND()': MySQL style
   */
  randomFunction?: 'RANDOM()' | 'RAND()'
  /**
   * Syntax used for shared row locks.
   * - 'FOR SHARE': PostgreSQL style shared lock
   * - 'LOCK IN SHARE MODE': MySQL style shared lock
   */
  sharedLockSyntax?: 'FOR SHARE' | 'LOCK IN SHARE MODE'
  /**
   * Mechanism used to express JSON contains semantics.
   * - 'operator': Use native operators when available (e.g., Postgres `@>`)
   * - 'function': Use function-based approach when operators are unavailable
   */
  jsonContainsMode?: 'operator' | 'function'
}

/**
 * # `QueryHooks`
 *
 * Optional lifecycle hooks around query execution. These are invoked for any
 * statement executed through the builder (select/insert/update/delete/raw).
 */
export interface QueryHooks {
  /** Called right before a query executes. */
  onQueryStart?: (event: { sql: string, params?: any[], kind?: 'select' | 'insert' | 'update' | 'delete' | 'raw' }) => void
  /** Called after a query succeeds. */
  onQueryEnd?: (event: { sql: string, params?: any[], durationMs: number, rowCount?: number, kind?: 'select' | 'insert' | 'update' | 'delete' | 'raw' }) => void
  /** Called after a query fails. */
  onQueryError?: (event: { sql: string, params?: any[], error: any, durationMs: number, kind?: 'select' | 'insert' | 'update' | 'delete' | 'raw' }) => void
  /** Optional tracer integration. Return an object with end() to finish a span. */
  startSpan?: (event: { sql: string, params?: any[], kind?: 'select' | 'insert' | 'update' | 'delete' | 'raw' }) => { end: (error?: any) => void }
}

/**
 * # `FeatureToggles`
 *
 * Optional features that may be enabled per instance.
 *
 * - `distinctOn`: Enables PostgreSQL-like `DISTINCT ON (...)` behavior in builders.
 */
export interface FeatureToggles {
  /** Enables PostgreSQL-like `DISTINCT ON (...)` builder support. */
  distinctOn: boolean
}

export interface DatabaseConfig {
  database: string
  username: string
  password: string
  host: string
  url?: string
  port: number
}

/**
 * # `QueryBuilderConfig`
 *
 * Global configuration for the query builder.
 *
 * - `verbose`: Enables extra logging/diagnostics from the builder.
 * - `dialect`: Target SQL dialect. See `SupportedDialect` for details.
 * - `timestamps`: Timestamp column naming conventions.
 * - `pagination`: Defaults for pagination helpers.
 * - `aliasing`: How relation columns are aliased in SELECT lists.
 * - `relations`: Foreign key naming and singularization conventions.
 * - `transactionDefaults`: Default retry/backoff/isolation behavior for transactions.
 * - `sql`: Dialect-specific SQL toggles.
 * - `features`: Optional feature flags.
 * - `debug.captureText`: When true, the builder exposes a `toText()` method to capture SQL text in memory for debugging.
 */
export interface QueryBuilderConfig {
  /** Enables extra logging/diagnostics from the builder. */
  verbose: boolean
  /** Target SQL dialect. */
  dialect: SupportedDialect

  database: DatabaseConfig

  /** Timestamp column naming conventions. */
  timestamps: TimestampConfig
  /** Defaults for pagination helpers. */
  pagination: PaginationConfig
  /** How relation columns are aliased in SELECT lists. */
  aliasing: AliasingConfig
  /** Foreign key naming and singularization conventions. */
  relations: RelationsConfig
  /** Default retry/backoff/isolation behavior for transactions. */
  transactionDefaults: TransactionDefaultsConfig
  /** Dialect-specific SQL toggles. */
  sql: SqlConfig
  /** Optional feature flags. */
  features: FeatureToggles
  /** Debug options. */
  debug?: {
    /** When true, capture query text for debugging via `toText()`. */
    captureText: boolean
  }
  /** Lifecycle query hooks for logging/tracing. */
  hooks?: QueryHooks
  /** Soft delete behavior. */
  softDeletes?: {
    /** When true, apply a default `WHERE deleted_at IS NULL` filter. */
    enabled: boolean
    /** Column name used for soft delete flag/timestamp. */
    column: string
    /** When true, default filter is applied unless `.withTrashed()` is called. */
    defaultFilter: boolean
  }
}

export interface CliOption {
  verbose: boolean
}

export interface SqlOptions {
  limit?: number
}

export interface WaitReadyOptions {
  attempts?: number
  delay?: number
}

export interface FileOptions {
  params?: string
}

export interface IntrospectOptions {
  verbose?: boolean
}

export interface MigrateOptions {
  dialect?: SupportedDialect
  state?: string
  apply?: boolean
  full?: boolean
}

export interface GenerateMigrationResult {
  sql: string
  sqlStatements: string[]
  hasChanges: boolean
  plan: any
}

export interface UnsafeOptions {
  params?: string
}
