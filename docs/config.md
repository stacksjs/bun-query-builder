# Configuration

The bun-query-builder configuration system allows you to customize behavior across dialects, performance settings, and development preferences.

**Nothing is ever required.** Every field is optional, at every depth — whatever you
leave out keeps the library default, so fields added in future releases never become
your problem.

## Quick Start

### A config file

`query-builder.config.ts` in your project root, picked up by `getConfig()`:

```ts
import { defineConfig } from 'bun-query-builder'

export default defineConfig({
  dialect: 'postgres',
  database: { database: 'my_app' },
})
```

```ts
// Then, once at app boot:
import { getConfig } from 'bun-query-builder'

await getConfig() // applies the config file + QUERY_BUILDER_* env vars
```

Loading is explicit and async on purpose: the builder otherwise runs off the
synchronous config singleton, so an early query can never race a background load.

### From application code

`setConfig()` deep-merges, and outranks the config file:

```ts
import { setConfig } from 'bun-query-builder'

setConfig({ dialect: 'sqlite', pagination: { defaultPerPage: 50 } })

// Naming one leaf keeps the rest of its section — retries becomes 5,
// while sqlStates and backoff keep their defaults.
setConfig({ transactionDefaults: { retries: 5 } })
```

Precedence is `defaults < config file < setConfig()`.

### Mutating the live config

```ts
import { config } from 'bun-query-builder'

config.dialect = 'postgres'
config.sql.randomFunction = 'RANDOM()'
config.aliasing.relationColumnAliasFormat = 'table_column'
```

Note that assigning a whole section (`config.sql = { … }`) replaces it rather than
merging — prefer `setConfig()` unless you mean to drop the other keys.

## The two config types

| Type | Role |
| --- | --- |
| `QueryBuilderOptions` | What you **write**. Every field optional, recursively. Use it for `query-builder.config.ts`, `setConfig()` and `db.configure()`. |
| `QueryBuilderConfig` | What you **read**. Your options merged over the defaults, every field present — the type of `config`, `defaultConfig` and `getConfig()`'s result. |

Annotate your own configuration with `QueryBuilderOptions` (or skip the decision
entirely and use `defineConfig`). Declaring it against the resolved
`QueryBuilderConfig` is what made every field added to this package a compile error
in downstream apps — see
[#1062](https://github.com/stacksjs/bun-query-builder/issues/1062).

The authoritative field list ships in the package's type declarations, so your editor
completes it inline; this page deliberately no longer duplicates the interface, since
a second hand-maintained copy of the config shape drifts exactly the way the types did.

## Environment-Specific Configurations

### Production PostgreSQL Setup

```ts
// High-performance production configuration for PostgreSQL
function configureProductionPostgres() {
  config.dialect = 'postgres'
  config.verbose = false

  // SQL settings optimized for PostgreSQL
  config.sql = {
    randomFunction: 'RANDOM()',
    sharedLockSyntax: 'FOR SHARE',
    jsonContainsMode: 'operator' // Use @> operator
  }

  // API-friendly response format
  config.aliasing.relationColumnAliasFormat = 'camelCase'

  // Optimized pagination for web APIs
  config.pagination = {
    defaultPerPage: 50,
    cursorColumn: 'id'
  }

  // Timestamp conventions
  config.timestamps = {
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    defaultOrderColumn: 'created_at'
  }

  // Robust transaction handling for high concurrency
  config.transactionDefaults = {
    retries: 3,
    isolation: 'read committed',
    sqlStates: ['40001', '40P01', '25P02'], // PostgreSQL serialization failures
    backoff: {
      baseMs: 100,
      factor: 2,
      maxMs: 2000,
      jitter: true
    }
  }

  // Enable PostgreSQL-specific features
  config.features.distinctOn = true

  // Production debugging (minimal)
  config.debug = { captureText: false }
}
```

### E-commerce MySQL Configuration

```ts
// E-commerce optimized configuration for MySQL
function configureEcommerceMysql() {
  config.dialect = 'mysql'
  config.verbose = false

  // MySQL-specific SQL syntax
  config.sql = {
    randomFunction: 'RAND()',
    sharedLockSyntax: 'LOCK IN SHARE MODE',
    jsonContainsMode: 'function' // Use JSON_CONTAINS function
  }

  // Database-friendly naming for reports
  config.aliasing.relationColumnAliasFormat = 'table_column'

  // Smaller pages for product listings
  config.pagination = {
    defaultPerPage: 25,
    cursorColumn: 'id'
  }

  // E-commerce timestamp handling
  config.timestamps = {
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    defaultOrderColumn: 'created_at'
  }

  // Aggressive retries for payment/inventory operations
  config.transactionDefaults = {
    retries: 5,
    isolation: 'repeatable read', // Important for inventory consistency
    sqlStates: ['40001', '40700', '41000'], // MySQL lock timeouts and deadlocks
    backoff: {
      baseMs: 200,
      factor: 2,
      maxMs: 5000,
      jitter: true
    }
  }

  // MySQL doesn't support DISTINCT ON
  config.features.distinctOn = false

  // Standard foreign key format
  config.relations.foreignKeyFormat = 'singularParent_id'
}
```

### Development SQLite Setup

```ts
// Development-friendly configuration for SQLite
function configureDevelopmentSqlite() {
  config.dialect = 'sqlite'
  config.verbose = true // More logging in development

  // SQLite settings
  config.sql = {
    randomFunction: 'RANDOM()',
    sharedLockSyntax: 'FOR SHARE', // Often ignored in SQLite
    jsonContainsMode: 'function' // If JSON1 extension is available
  }

  // Readable format for debugging
  config.aliasing.relationColumnAliasFormat = 'table.dot.column'

  // Smaller pages for testing
  config.pagination = {
    defaultPerPage: 10,
    cursorColumn: 'id'
  }

  // Simple timestamp handling
  config.timestamps = {
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    defaultOrderColumn: 'created_at'
  }

  // Minimal retries for development
  config.transactionDefaults = {
    retries: 1,
    isolation: 'read committed',
    sqlStates: [], // SQLite has different error handling
    backoff: {
      baseMs: 50,
      factor: 1.5,
      maxMs: 200,
      jitter: false
    }
  }

  // SQLite limitations
  config.features.distinctOn = false

  // Enable debugging features
  config.debug = { captureText: true }
}
```

## Monitoring and Observability Configuration

```ts
// Production monitoring setup
function configureMonitoring() {
  config.hooks = {
    onQueryStart: ({ sql, kind }) => {
      console.log(`🔍 Query started: ${kind}`)
      // Send to APM (New Relic, DataDog, etc.)
      apm.startTransaction(`db.${kind}`, { sql })
    },

    onQueryEnd: ({ sql, kind, durationMs, rowCount }) => {
      console.log(`✅ Query completed: ${kind} (${durationMs}ms, ${rowCount} rows)`)

      // Performance monitoring
      metrics.timing('db.query.duration', durationMs, { kind })
      metrics.gauge('db.query.rows', rowCount, { kind })

      // Slow query alerting
      if (durationMs > 1000) {
        console.warn(`🐌 Slow query detected: ${sql} (${durationMs}ms)`)
        alerts.slowQuery({ sql, duration: durationMs, kind })
      }
    },

    onQueryError: ({ sql, kind, error }) => {
      console.error(`❌ Query failed: ${kind}`, error)

      // Error tracking
      errorTracker.captureException(error, {
        tags: { kind, sql: sql.substring(0, 100) },
        extra: { fullSql: sql }
      })

      // Error metrics
      metrics.increment('db.query.error', { kind, errorType: error.name })
    },

    startSpan: (name: string) => {
      // OpenTelemetry or similar tracing
      const span = tracer.startSpan(name)
      return {
        end: () => span.end()
      }
    }
  }
}
```

## Dynamic Configuration Patterns

```ts
// Environment-based configuration loading
function loadConfigurationForEnvironment() {
  const environment = process.env.NODE_ENV || 'development'
  const dialect = process.env.DB_DIALECT as 'postgres' | 'mysql' | 'sqlite'

  // Base configuration
  const baseConfig = {
    verbose: environment === 'development',
    debug: { captureText: environment !== 'production' }
  }

  // Apply base config
  Object.assign(config, baseConfig)

  // Dialect-specific configuration
  switch (dialect) {
    case 'postgres':
      configureProductionPostgres()
      break
    case 'mysql':
      configureEcommerceMysql()
      break
    case 'sqlite':
      configureDevelopmentSqlite()
      break
    default:
      throw new Error(`Unsupported dialect: ${dialect}`)
  }

  // Environment-specific overrides
  switch (environment) {
    case 'production':
      configureMonitoring()
      // Lock configuration in production
      Object.freeze(config)
      break

    case 'test':
      // Fast-fail for tests
      config.transactionDefaults.retries = 0
      config.pagination.defaultPerPage = 5
      break

    case 'development':
      // Enable all debugging features
      config.debug.captureText = true
      config.verbose = true
      break
  }

  console.log(`📊 Database configured: ${dialect} dialect in ${environment} environment`)
}

// Initialize configuration
loadConfigurationForEnvironment()
```

## Configuration Validation

```ts
// Validate configuration at startup
function validateConfiguration() {
  const errors: string[] = []

  // Required settings
  if (!config.dialect) {
    errors.push('dialect is required')
  }

  // Dialect-specific validation
  if (config.dialect === 'postgres' && !config.features.distinctOn) {
    console.warn('⚠️  PostgreSQL detected but distinctOn feature is disabled')
  }

  if (config.dialect === 'sqlite' && config.features.distinctOn) {
    console.warn('⚠️  SQLite does not support DISTINCT ON, disabling feature')
    config.features.distinctOn = false
  }

  // Performance validation
  if (config.transactionDefaults.retries > 10) {
    console.warn('⚠️  High retry count may impact performance')
  }

  if (config.pagination.defaultPerPage > 1000) {
    console.warn('⚠️  Large page size may impact memory usage')
  }

  // Security validation
  if (config.debug?.captureText && process.env.NODE_ENV === 'production') {
    errors.push('debug.captureText should not be enabled in production')
  }

  if (errors.length > 0) {
    throw new Error(`Configuration errors: ${errors.join(', ')}`)
  }

  console.log('✅ Configuration validation passed')
}

// Validate after configuration
validateConfiguration()
```

## Best Practices

### Development

- **Enable Debugging**: Use `debug.captureText = true` and `verbose = true` for development
- **Small Pages**: Use smaller `defaultPerPage` values for faster development feedback
- **Minimal Retries**: Set low retry counts to fail fast during development

### Production

- **Disable Debugging**: Turn off `debug.captureText` to prevent memory leaks
- **Optimize Retries**: Configure appropriate retry counts based on your workload
- **Monitor Performance**: Use query hooks for APM integration and slow query detection
- **Lock Configuration**: Use `Object.freeze(config)` to prevent runtime changes

### Security

- **Validate Configuration**: Implement startup validation to catch misconfigurations
- **Environment Separation**: Use different configurations for different environments
- **Secrets Management**: Keep database credentials separate from configuration code
- **Audit Changes**: Log and monitor configuration changes in production

### Team Collaboration

- **Document Decisions**: Comment configuration choices and their rationale
- **Version Control**: Store configuration in version-controlled files
- **Review Changes**: Treat configuration changes like code changes in reviews
- **Test Configurations**: Test different dialect configurations in CI/CD pipelines
