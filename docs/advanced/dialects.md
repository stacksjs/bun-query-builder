# Dialects & Config

Configure behavior to match your database dialect and preferences. The global `config` controls defaults for timestamps, pagination, aliasing, relations, transaction behavior, SQL features, and debug.

## Overview

The library reads config via bunfig at runtime. You can also tweak `config` directly at startup or call `db.configure()` per builder instance (lightweight overrides).

## Core Settings

```ts
import { config } from 'bun-query-builder'

config.verbose = true
config.dialect = 'postgres' // 'mysql' | 'sqlite'
```

## SQL Dialect Settings

Random function and shared lock syntax vary by dialect:

```ts
config.sql.randomFunction = 'RANDOM()' // PG
config.sql.sharedLockSyntax = 'FOR SHARE' // PG
config.sql.jsonContainsMode = 'operator' // PG uses @>

// MySQL
config.dialect = 'mysql'
config.sql.randomFunction = 'RAND()'
config.sql.sharedLockSyntax = 'LOCK IN SHARE MODE'
config.sql.jsonContainsMode = 'function' // JSON_CONTAINS
```

## Relations and Aliasing

```ts
config.relations = {
  foreignKeyFormat: 'singularParent_id',
  singularizeStrategy: 'stripTrailingS',
}

config.aliasing = {
  relationColumnAliasFormat: 'table_column', // or 'table.dot.column' | 'camelCase'
}
```

## Pagination Defaults

```ts
config.pagination = {
  defaultPerPage: 25,
  cursorColumn: 'id',
}
```

## Timestamps

```ts
config.timestamps = {
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  defaultOrderColumn: 'created_at',
}
```

## Transactions

```ts
config.transactionDefaults = {
  retries: 2,
  isolation: 'read committed',
  sqlStates: ['40001', '40P01'],
  backoff: { baseMs: 50, factor: 2, maxMs: 2000, jitter: true },
}
```

## Feature Flags

```ts
config.features = {
  distinctOn: true, // PG only
}
```

## Debugging

```ts
config.debug = {
  captureText: false,
}

// Optional lifecycle hooks and tracing
config.hooks = {
  onQueryStart: ({ sql, kind }) => logger.debug({ kind, sql }),
  onQueryEnd: ({ durationMs, rowCount }) => logger.info({ durationMs, rowCount }),
  onQueryError: ({ error }) => logger.error(error),
}
```

## Examples

### Production Configuration Setup

```ts
// Chris's team PostgreSQL setup for production
function configurePostgresProduction() {
  config.dialect = 'postgres'
  config.sql.randomFunction = 'RANDOM()'
  config.sql.sharedLockSyntax = 'FOR SHARE'
  config.sql.jsonContainsMode = 'operator'
  config.features.distinctOn = true

  // Optimized for high-concurrency production workload
  config.transactionDefaults = {
    retries: 3,
    isolation: 'read committed',
    sqlStates: ['40001', '40P01', '25P02'],
    backoff: { baseMs: 50, factor: 2, maxMs: 2000, jitter: true }
  }

  // API-friendly aliasing
  config.aliasing.relationColumnAliasFormat = 'camelCase'
  config.pagination.defaultPerPage = 50
  config.timestamps = {
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    defaultOrderColumn: 'created_at'
  }
}

// Avery's team MySQL setup for e-commerce
function configureMySQLEcommerce() {
  config.dialect = 'mysql'
  config.sql.randomFunction = 'RAND()'
  config.sql.sharedLockSyntax = 'LOCK IN SHARE MODE'
  config.sql.jsonContainsMode = 'function'

  // Heavy retry for payment/inventory operations
  config.transactionDefaults = {
    retries: 5,
    isolation: 'repeatable read',
    sqlStates: ['40001', '40700', '41000'],
    backoff: { baseMs: 100, factor: 2, maxMs: 5000, jitter: true }
  }

  // Optimized for analytics queries
  config.pagination.defaultPerPage = 25
  config.aliasing.relationColumnAliasFormat = 'table_column'
}

// Buddy's SQLite setup for local development
function configureSQLiteDevelopment() {
  config.dialect = 'sqlite'
  config.sql.randomFunction = 'RANDOM()'
  config.sql.sharedLockSyntax = 'FOR SHARE' // Usually ignored in SQLite
  config.features.distinctOn = false // Not supported

  // Simple config for local development
  config.transactionDefaults = {
    retries: 1,
    isolation: 'read committed',
    sqlStates: [],
    backoff: { baseMs: 10, factor: 1.5, maxMs: 100, jitter: false }
  }

  config.debug = { captureText: true }
  config.verbose = true
}
```

### Environment-Based Configuration

```ts
// Auto-configure based on environment
function autoConfigureDialect() {
  const dialect = process.env.DB_DIALECT as 'postgres' | 'mysql' | 'sqlite'
  const environment = process.env.NODE_ENV

  switch (dialect) {
    case 'postgres':
      configurePostgresProduction()
      if (environment === 'development') {
        config.debug = { captureText: true }
        config.verbose = true
      }
      break

    case 'mysql':
      configureMySQLEcommerce()
      // MySQL-specific optimizations
      config.relations.foreignKeyFormat = 'singularParent_id'
      break

    case 'sqlite':
      configureSQLiteDevelopment()
      // SQLite-specific settings
      config.pagination.defaultPerPage = 10 // Smaller pages for testing
      break

    default:
      throw new Error(`Unsupported dialect: ${dialect}`)
  }

  console.log(`Configured for ${dialect} dialect in ${environment} environment`)
}

// Initialize based on environment
autoConfigureDialect()
```

### Team-Specific Configurations

```ts
// Chris's analytics team configuration
function configureAnalyticsTeam() {
  config.pagination.defaultPerPage = 100 // Larger pages for reports
  config.aliasing.relationColumnAliasFormat = 'table.dot.column' // SQL-friendly
  config.timestamps.defaultOrderColumn = 'updated_at' // Most recent changes

  // Optimized for complex analytical queries
  config.transactionDefaults.isolation = 'repeatable read'
  config.transactionDefaults.retries = 2 // Analytics can retry
}

// Avery's API team configuration
function configureAPITeam() {
  config.pagination.defaultPerPage = 20 // Small pages for mobile
  config.aliasing.relationColumnAliasFormat = 'camelCase' // JSON-friendly
  config.timestamps.defaultOrderColumn = 'created_at' // Chronological order

  // Fast fail for API responses
  config.transactionDefaults.retries = 1
  config.transactionDefaults.backoff = { baseMs: 50, factor: 1, maxMs: 50, jitter: false }
}

// Buddy's batch processing team configuration
function configureBatchTeam() {
  config.pagination.defaultPerPage = 1000 // Large pages for bulk processing
  config.aliasing.relationColumnAliasFormat = 'table_column' // Processing-friendly

  // Heavy retries for batch operations
  config.transactionDefaults.retries = 10
  config.transactionDefaults.backoff = { baseMs: 500, factor: 2, maxMs: 10000, jitter: true }
}

// Apply team-specific settings based on service
const teamConfig = {
  'analytics-service': configureAnalyticsTeam,
  'api-service': configureAPITeam,
  'batch-service': configureBatchTeam
}

const serviceName = process.env.SERVICE_NAME
if (serviceName && teamConfig[serviceName]) {
  teamConfig[serviceName]()
}
```

## Best Practices

### Configuration Management

- **Early Configuration**: Set dialect and related settings early in application bootstrap
- **Environment Consistency**: Use the same dialect across development, staging, and production
- **Team Standards**: Establish consistent configuration patterns across your organization
- **Version Control**: Store configuration in version-controlled files, not environment variables alone

```ts
// Good: Centralized configuration module
// config/database.ts
export function configureDatabaseForEnvironment() {
  const environment = process.env.NODE_ENV
  const dialect = process.env.DB_DIALECT

  // Base configuration
  const baseConfig = {
    verbose: environment === 'development',
    debug: { captureText: environment !== 'production' }
  }

  // Dialect-specific settings
  switch (dialect) {
    case 'postgres':
      return { ...baseConfig, ...getPostgresConfig() }
    case 'mysql':
      return { ...baseConfig, ...getMySQLConfig() }
    case 'sqlite':
      return { ...baseConfig, ...getSQLiteConfig() }
    default:
      throw new Error(`Unsupported dialect: ${dialect}`)
  }
}

// Apply at startup
Object.assign(config, configureDatabaseForEnvironment())
```

### Performance Optimization

- **Dialect-Specific Features**: Leverage unique features of your chosen dialect
- **Index Strategy**: Use dialect-appropriate indexing strategies
- **Query Optimization**: Tune queries for your specific database engine
- **Connection Pooling**: Configure pool sizes based on dialect characteristics

```ts
// PostgreSQL optimizations
function optimizeForPostgres() {
  // Use advanced PostgreSQL features
  config.features.distinctOn = true
  config.sql.jsonContainsMode = 'operator' // Use @> operator

  // PostgreSQL-friendly pagination
  config.pagination.defaultPerPage = 50

  // Leverage PostgreSQL's robust transaction support
  config.transactionDefaults.isolation = 'read committed'
  config.transactionDefaults.retries = 3
}

// MySQL optimizations for Avery's e-commerce platform
function optimizeForMySQL() {
  // MySQL-specific settings
  config.sql.randomFunction = 'RAND()'
  config.sql.jsonContainsMode = 'function' // Use JSON_CONTAINS

  // MySQL handles smaller transactions better
  config.pagination.defaultPerPage = 25
  config.transactionDefaults.isolation = 'repeatable read'
}

// SQLite optimizations for Buddy's development environment
function optimizeForSQLite() {
  // SQLite limitations
  config.features.distinctOn = false

  // Smaller pages for SQLite
  config.pagination.defaultPerPage = 20

  // Simple transaction handling
  config.transactionDefaults.retries = 1
  config.transactionDefaults.isolation = 'read committed'
}
```

### Cross-Dialect Compatibility

- **Feature Detection**: Check dialect capabilities before using advanced features
- **Graceful Degradation**: Provide fallbacks for unsupported features
- **Testing Strategy**: Test against all target dialects in CI
- **Migration Strategy**: Plan for potential dialect changes

```ts
// Feature detection pattern
function getRandomOrderQuery() {
  const randomFunction = config.sql.randomFunction || 'RANDOM()'

  return db
    .selectFrom('quotes')
    .orderByRaw(db.sql`${randomFunction}`)
    .limit(1)
}

// Graceful degradation for DISTINCT ON
function getLatestUserPerTeam() {
  if (config.features.distinctOn && config.dialect === 'postgres') {
    // Use PostgreSQL DISTINCT ON
    return db
      .selectFrom('users')
      .distinctOn('team_id')
      .orderBy('team_id', 'asc')
      .orderBy('created_at', 'desc')
  }
  else {
    // Fallback using window functions or subqueries
    return db
      .selectFrom('users')
      .whereIn('id', db.selectFrom('users as u2')
        .select('u2.id')
        .whereColumn('u2.team_id', '=', 'users.team_id')
        .orderBy('u2.created_at', 'desc')
        .limit(1))
  }
}
```

### Security and Compliance

- **Parameter Validation**: Validate configuration parameters at startup
- **Access Control**: Restrict configuration changes in production
- **Audit Logging**: Log configuration changes and their sources
- **Secrets Management**: Keep sensitive connection details secure

```ts
// Configuration validation
function validateConfiguration() {
  const requiredSettings = ['dialect', 'sql.randomFunction']

  for (const setting of requiredSettings) {
    const value = getNestedProperty(config, setting)
    if (!value) {
      throw new Error(`Required configuration missing: ${setting}`)
    }
  }

  // Dialect-specific validation
  if (config.dialect === 'postgres' && !config.features.distinctOn) {
    console.warn('PostgreSQL detected but distinctOn feature is disabled')
  }

  if (config.dialect === 'sqlite' && config.features.distinctOn) {
    console.warn('SQLite does not support DISTINCT ON, disabling feature')
    config.features.distinctOn = false
  }
}

// Production configuration lock
if (process.env.NODE_ENV === 'production') {
  Object.freeze(config)
  console.log('Database configuration locked for production')
}
```

### Team Collaboration

- **Documentation**: Document configuration decisions and their rationale
- **Code Reviews**: Review configuration changes like code changes
- **Monitoring**: Monitor the impact of configuration changes on performance
- **Rollback Strategy**: Have a plan to quickly revert configuration changes

```ts
// Configuration documentation example
const configurationRationale = {
  'postgres-production': {
    retries: 3,
    reasoning: 'Chris determined 3 retries optimal for our high-concurrency workload',
    lastReviewed: '2024-01-15',
    nextReview: '2024-04-15'
  },
  'mysql-ecommerce': {
    isolation: 'repeatable read',
    reasoning: 'Avery requires consistent reads for inventory management',
    lastReviewed: '2024-01-10',
    nextReview: '2024-04-10'
  },
  'sqlite-development': {
    captureText: true,
    reasoning: 'Buddy enabled for debugging in development environment',
    lastReviewed: '2024-01-20',
    nextReview: '2024-02-20'
  }
}

// Configuration change monitoring
function trackConfigurationChange(key: string, oldValue: any, newValue: any) {
  const change = {
    timestamp: new Date().toISOString(),
    key,
    oldValue,
    newValue,
    user: process.env.USER || 'unknown',
    environment: process.env.NODE_ENV || 'unknown'
  }

  console.log('Configuration change:', change)

  // Send to monitoring system
  metrics.increment('config.change', { key })
}
```

## FAQ

### How do per-instance overrides work?

Call `db.configure(partialConfig)` to shallow-merge selected properties for that builder instance.

### Can I change config at runtime?

Yes. Changing `config` affects subsequently created queries. Prefer setting once during app boot.

---

## Postgres Notes

- DISTINCT ON supported (`config.features.distinctOn = true`)
- RETURNING supported on INSERT/UPDATE/DELETE
- JSON operators `@>`, `->`, `->>` are available; we use operator mode by default
- Shared lock syntax: `FOR SHARE`; row locking via `FOR UPDATE`
- Random function: `RANDOM()`

### Examples

```ts
await db.selectFrom('users').distinctOn('email').orderBy('email').execute()
await db.insertInto('users').values({ name: 'A' }).returning('id').execute()
await db.selectFrom('docs').whereJsonContains('content', { published: true }).execute()
```

## MySQL Notes

- Use `RAND()` for random ordering
- Shared lock syntax: `LOCK IN SHARE MODE`
- JSON containment via `JSON_CONTAINS` when `config.sql.jsonContainsMode = 'function'`
- Upsert via `ON DUPLICATE KEY UPDATE` (our `upsert` helper may emulate using `ON CONFLICT` style on PG)

### Examples

```ts
config.dialect = 'mysql'
config.sql.randomFunction = 'RAND()'
config.sql.sharedLockSyntax = 'LOCK IN SHARE MODE'
config.sql.jsonContainsMode = 'function'

await db.selectFrom('tips').inRandomOrder().execute()
await db.selectFrom('items').sharedLock().execute()
await db.selectFrom('docs').whereJsonContains('content', { published: true }).execute()
```

## SQLite Notes

- Random function: `RANDOM()`
- Locking semantics differ; `FOR UPDATE` may be a no-op
- RETURNING support exists in modern SQLite builds; verify your version
- JSON functions via the JSON1 extension

### Examples

```ts
config.dialect = 'sqlite'
config.sql.randomFunction = 'RANDOM()'
config.sql.sharedLockSyntax = 'FOR SHARE'
```

## Identifiers and Quoting

- We rely on Bun `sql` for identifier quoting; avoid interpolating raw identifiers without validation
- Prefer structured helpers over raw `sql``${table}.${column}``

## Pagination Differences

- All supported dialects use `LIMIT`/`OFFSET`; performance implications differ
- For deep pagination, prefer `cursorPaginate`
- Composite cursors are supported by passing multiple columns (e.g., `['created_at', 'id']`)

## Timezones and Types

- Store timestamps in UTC; convert at the application edge
- Booleans may map to `tinyint(1)` in MySQL; ensure truthiness expectations

## Performance Tips Per Dialect

- Postgres: leverage `EXPLAIN (ANALYZE, BUFFERS)` during tuning; create appropriate indexes for JSON paths if needed
- MySQL: ensure proper collations and indexes on text columns; beware of implicit conversions
- SQLite: keep transactions short; consider WAL mode for concurrency

## Collations and Charsets

- Choose a consistent collation/charset (e.g., `utf8mb4` for MySQL) to avoid comparison surprises

## Prepared Statement Considerations

- Some dialects/drivers have limits on placeholders; batch operations accordingly

## Examples: Cross-dialect Random

```ts
// PG / SQLite
config.sql.randomFunction = 'RANDOM()'
await db.selectFrom('quotes').inRandomOrder().limit(1).execute()

// MySQL
config.sql.randomFunction = 'RAND()'
await db.selectFrom('quotes').inRandomOrder().limit(1).execute()
```

## Examples: JSON contains

```ts
// PG operator
config.sql.jsonContainsMode = 'operator'
await db.selectFrom('docs').whereJsonContains('meta', { a: 1 })

// MySQL function
config.sql.jsonContainsMode = 'function'
await db.selectFrom('docs').whereJsonContains('meta', { a: 1 })
```

## Troubleshooting

- Syntax error with `distinctOn`: ensure `config.features.distinctOn = true` and dialect is PG
- `sharedLock` no effect: dialect may not support; verify generated SQL
- JSON contains mismatch: switch mode between `operator` and `function` per dialect

## Migration Strategy

- Keep dialect-sensitive features behind config toggles
- Centralize dialect assumptions in one module for easy review

## Checklist

- [ ] Set dialect early in app boot
- [ ] Align random/lock/JSON settings to dialect
- [ ] Verify returning support before relying on it
- [ ] Prefer cursor-based pagination for deep pages
