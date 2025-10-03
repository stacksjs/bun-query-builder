# Debugging

Techniques for inspecting queries, printing SQL, and understanding performance characteristics.

## Overview

By default, the builder returns Bun query objects rather than strings. This preserves parameterization and performance. For debugging and tests, enable `toText` to access a string representation.

## Enabling toText

```ts
import { config } from 'bun-query-builder'
config.debug = { captureText: true }

const q = db.selectFrom('users').where({ active: true })
console.log((q as any).toText?.())
```

Disable in production to avoid overhead and accidental logging of sensitive text.

## Dump, DD, and Explain

```ts
// Quick SQL debugging during development
const users = await db
  .selectFrom('users')
  .where({ active: true, role: 'admin' })
  .dump() // Prints SQL to console
  .execute()

// Debug and stop execution
await db
  .selectFrom('projects')
  .where({ owner: 'Chris' })
  .with('collaborators')
  .dd() // Prints SQL then throws error to stop execution

// Get query execution plan for performance analysis
const explain = await db
  .selectFrom('users')
  .innerJoin('orders', 'orders.user_id', '=', 'users.id')
  .where(['orders.created_at', '>', new Date('2024-01-01')])
  .explain()

console.log('Query plan:', explain)

// Complex query performance analysis
const complexExplain = await db
  .selectFrom('users')
  .with('Project', 'Team')
  .where({ 'users.active': true })
  .whereHas('Project', ['status', '=', 'active'])
  .orderBy('users.created_at', 'desc')
  .limit(50)
  .explain()

// Analyze the plan to identify missing indexes or inefficient operations
```

**Use Cases:**

- `dump()`: Quick debugging without stopping execution
- `dd()`: Debug and halt (development only)
- `explain()`: Performance analysis and index optimization

## Logging Queries

Wrap builder calls and log `(q as any).toText?.()` when `captureText` is on.

## Snapshot Testing

Enable `captureText` in tests to snapshot SQL text for critical queries.

```ts
import { config } from 'bun-query-builder'
config.debug = { captureText: true }
const q = db.selectFrom('orders').where(['status', '=', 'paid']).toSQL()
expect(q.toText()).toContain('SELECT')
```

## Query hooks and tracing

Set `config.hooks` to observe query lifecycle events or attach tracing spans:

```ts
import { config } from 'bun-query-builder'
import { logger } from './logger'
import { tracer } from './tracing'

// Comprehensive query monitoring setup
config.hooks = {
  onQueryStart: ({ sql, kind, params }) => {
    logger.debug({
      event: 'query_start',
      kind,
      sql: process.env.NODE_ENV === 'development' ? sql : '[redacted]',
      paramCount: params?.length || 0,
      timestamp: new Date().toISOString()
    })
  },

  onQueryEnd: ({ sql, durationMs, rowCount, kind }) => {
    // Log slow queries
    if (durationMs > 1000) {
      logger.warn({
        event: 'slow_query',
        kind,
        durationMs,
        rowCount,
        sql: process.env.NODE_ENV === 'development' ? sql : '[redacted]'
      })
    }

    // Regular query completion logging
    logger.info({
      event: 'query_end',
      kind,
      durationMs,
      rowCount,
      timestamp: new Date().toISOString()
    })
  },

  onQueryError: ({ sql, error, durationMs, kind }) => {
    logger.error({
      event: 'query_error',
      kind,
      error: error.message,
      durationMs,
      sql: process.env.NODE_ENV === 'development' ? sql : '[redacted]',
      stack: error.stack
    })

    // Send to error tracking service
    if (process.env.NODE_ENV === 'production') {
      errorTracker.captureException(error, {
        tags: { component: 'database', operation: kind },
        extra: { durationMs, sql: '[redacted]' }
      })
    }
  },

  startSpan: ({ sql, kind, params }) => {
    const span = tracer.startSpan(`db.${kind}`, {
      attributes: {
        'db.system': 'postgresql',
        'db.operation': kind,
        'db.statement': process.env.NODE_ENV === 'development' ? sql : '[redacted]',
        'db.param_count': params?.length || 0
      }
    })

    return {
      end: (error?: any) => {
        if (error) {
          span.recordException(error)
          span.setStatus({ code: 2, message: error.message }) // ERROR
        }
        else {
          span.setStatus({ code: 1 }) // OK
        }
        span.end()
      }
    }
  }
}

// Team-specific debugging for Chris's queries
function debugChrisQueries() {
  const originalHooks = { ...config.hooks }

  config.hooks = {
    ...originalHooks,
    onQueryStart: (event) => {
      if (event.sql?.includes('\'Chris\'') || event.sql?.includes('chris@')) {
        console.log('🔍 Chris query detected:', event.sql)
      }
      originalHooks.onQueryStart?.(event)
    }
  }
}

// Enable Chris debugging in development
if (process.env.NODE_ENV === 'development' && process.env.DEBUG_CHRIS === '1') {
  debugChrisQueries()
}
```

## Timeouts and cancellation

```ts
await db.selectFrom('users').withTimeout(500).get()

const ac = new AbortController()
const p = db.selectFrom('users').abort(ac.signal).get()
ac.abort()
await p
```

## ILIKE and JSON helpers

```ts
db.selectFrom('users').whereILike?.('name', '%ali%').get()
db.selectFrom('users').whereJsonContains('prefs', { theme: 'dark' }).get()
db.selectFrom('users').whereJsonPath?.('prefs->theme', '=', 'dark').get()
```

## Relation eager loading

```ts
db.selectFrom('users').with?.('posts', 'posts.tags').get()
```

## Composite cursor pagination

```ts
const page = await db.selectFrom('users').cursorPaginate(25, undefined, ['created_at', 'id'], 'asc')
const next = await db.selectFrom('users').cursorPaginate(25, page.meta.nextCursor, ['created_at', 'id'])
```

## Common Pitfalls

- Comparing query object directly to string (enable toText instead)
- Forgetting to disable `captureText` in production

## Best Practices

### Development Environment

- **Enable Text Capture**: Use `config.debug.captureText = true` in development for SQL inspection
- **Conditional Debugging**: Toggle debug features with environment variables
- **Query Inspection**: Use `dump()` for quick debugging without stopping execution
- **Performance Analysis**: Regularly use `explain()` to identify optimization opportunities

```ts
// Development-only debugging setup
if (process.env.NODE_ENV === 'development') {
  config.debug = { captureText: true }
  config.verbose = true

  // Enable query logging for specific patterns
  if (process.env.DEBUG_QUERIES) {
    config.hooks = {
      onQueryStart: ({ sql }) => console.log('🔍 SQL:', sql),
      onQueryEnd: ({ durationMs }) => console.log(`⏱️  ${durationMs}ms`)
    }
  }
}

// Feature-specific debugging
const debugUserQueries = process.env.DEBUG_USERS === '1'
const userQuery = db
  .selectFrom('users')
  .where({ team: 'Engineering' })
  .when(debugUserQueries, qb => qb.dump())
  .execute()
```

### Production Environment

- **Disable Text Capture**: Never enable `captureText` in production to avoid performance overhead
- **Structured Logging**: Use structured logs with appropriate log levels
- **Error Tracking**: Integrate with error tracking services for query failures
- **Performance Monitoring**: Track slow queries and database metrics

```ts
// Production-safe configuration
if (process.env.NODE_ENV === 'production') {
  config.debug = { captureText: false }
  config.hooks = {
    onQueryEnd: ({ durationMs, kind, rowCount }) => {
      // Log slow queries only
      if (durationMs > 2000) {
        logger.warn({
          message: 'Slow query detected',
          durationMs,
          operation: kind,
          rowCount,
          timestamp: new Date().toISOString()
        })
      }
    },

    onQueryError: ({ error, kind, durationMs }) => {
      logger.error({
        message: 'Database query failed',
        error: error.message,
        operation: kind,
        durationMs,
        timestamp: new Date().toISOString()
      })

      // Send to error tracking
      Sentry.captureException(error, {
        tags: { component: 'database' },
        extra: { operation: kind, durationMs }
      })
    }
  }
}
```

### Testing Environment

- **Query Snapshots**: Capture and test SQL output for critical queries
- **Performance Testing**: Establish performance baselines for important operations
- **Error Simulation**: Test error handling paths with malformed queries
- **Integration Testing**: Verify query behavior with real database connections

```ts
// Testing setup
describe('User queries', () => {
  beforeAll(() => {
    config.debug = { captureText: true }
  })

  it('should generate correct SQL for active users', () => {
    const query = db
      .selectFrom('users')
      .where({ active: true, role: 'admin' })
      .orderBy('created_at', 'desc')
      .toSQL()

    expect(query.toText()).toContain('WHERE active = ? AND role = ?')
    expect(query.toText()).toContain('ORDER BY created_at DESC')
  })

  it('should perform within acceptable time limits', async () => {
    const start = Date.now()

    await db
      .selectFrom('users')
      .where({ active: true })
      .limit(100)
      .execute()

    const duration = Date.now() - start
    expect(duration).toBeLessThan(1000) // Should complete within 1 second
  })

  // Test with Avery's data
  it('should handle Avery\'s complex queries efficiently', async () => {
    const start = Date.now()

    const results = await db
      .selectFrom('users')
      .where({ name: 'Avery' })
      .with('Project', 'Team')
      .withCount('Post', 'post_count')
      .execute()

    const duration = Date.now() - start
    expect(duration).toBeLessThan(500)
    expect(results).toBeDefined()
  })
})
```

### Security and Privacy

- **Redact Sensitive Data**: Never log sensitive information like passwords or tokens
- **Parameter Masking**: Mask or exclude sensitive parameters from logs
- **Access Control**: Ensure debug logs are properly secured and access-controlled
- **Compliance**: Follow data protection regulations when logging queries

```ts
// Secure logging implementation
function sanitizeSQL(sql: string): string {
  return sql
    .replace(/(password|token|secret)\s*=\s*['"][^'"]*['"]/gi, 'REDACTED_FIELD = [REDACTED]')
    .replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '[CARD_REDACTED]')
    .replace(/\b\w+@\w+\.\w{2,}\b/g, '[EMAIL_REDACTED]')
}

config.hooks = {
  onQueryStart: ({ sql }) => {
    if (process.env.NODE_ENV === 'development') {
      logger.debug({ sql: sanitizeSQL(sql) })
    }
  }
}

// Example with Buddy's secure data handling
async function buddySecureQuery() {
  // This query won't leak Buddy's email in logs
  return await db
    .selectFrom('users')
    .where({ email: 'buddy@secret-company.com' })
    .dump() // Will show redacted email in logs
    .execute()
}
```

### Performance Optimization

- **Query Analysis**: Use `explain()` to understand query execution plans
- **Index Identification**: Identify missing indexes from slow query patterns
- **Metric Collection**: Collect and analyze query performance metrics over time
- **Optimization Tracking**: Track improvements after optimization changes

```ts
// Performance monitoring helper
async function monitorQuery<T>(queryFn: () => Promise<T>, operation: string, threshold: number = 1000): Promise<T> {
  const start = performance.now()

  try {
    const result = await queryFn()
    const duration = performance.now() - start

    if (duration > threshold) {
      logger.warn({
        message: 'Performance threshold exceeded',
        operation,
        duration: Math.round(duration),
        threshold
      })
    }

    // Collect metrics
    metrics.timing('database.query.duration', duration, { operation })

    return result
  }
  catch (error) {
    const duration = performance.now() - start

    logger.error({
      message: 'Query failed',
      operation,
      duration: Math.round(duration),
      error: error.message
    })

    throw error
  }
}

// Usage
const chrisProjects = await monitorQuery(
  () => db.selectFrom('projects').where({ owner: 'Chris' }).execute(),
  'get_chris_projects',
  500 // 500ms threshold
)
```

### Debugging Workflows

- **Incremental Building**: Build complex queries step by step with intermediate `dump()` calls
- **Isolation Testing**: Test problematic queries in isolation before integrating
- **Data Verification**: Verify query results match expected business logic
- **Cross-Environment Testing**: Test queries across different database environments

```ts
// Step-by-step query debugging
async function debugComplexQuery() {
  // Start with basic query
  const baseQuery = db
    .selectFrom('users')
    .where({ active: true })
    .dump() // Check base SQL

  // Add joins
  const withJoins = baseQuery
    .with('Project')
    .dump() // Check join SQL

  // Add filtering
  const withFilters = withJoins
    .whereHas('Project', ['status', '=', 'active'])
    .dump() // Check final SQL

  // Execute and verify
  const results = await withFilters.execute()
  console.log(`Found ${results.length} users with active projects`)

  return results
}
```

---

## Per-instance Debugging

You can toggle debugging on a specific builder instance without changing global config.

```ts
const local = createQueryBuilder<typeof schema>({ meta, schema })
local.configure({ debug: { captureText: true } })
const q = local.selectFrom('users').limit(1).toSQL()
console.log(q.toText())
```

## Enabling via Environment

```ts
// bootstrap.ts
import { config } from 'bun-query-builder'
if (process.env.QB_CAPTURE_TEXT === '1')
  config.debug = { captureText: true }
```

## Masking Parameters

When logging SQL, consider masking secrets.

```ts
function mask(obj: any) {
  const clone = { ...obj }
  for (const k of Object.keys(clone)) {
    if (/(password|secret|token|api[_-]?key)/i.test(k))
      clone[k] = '[redacted]'
  }
  return clone
}
```

## Formatting SQL for Readability

```ts
function format(sql: string): string {
  return sql
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .trim()
}
```

## Logging with Pino

```ts
import { config } from 'bun-query-builder'
import pino from 'pino'

const logger = pino({ level: 'info' })
config.debug = { captureText: true }

async function logQuery(label: string, q: any) {
  logger.info({ label, sql: q.toText?.() }, 'SQL')
}
```

## Logging with Winston

```ts
import { config } from 'bun-query-builder'
import winston from 'winston'

const logger = winston.createLogger({ transports: [new winston.transports.Console()] })
config.debug = { captureText: true }

async function logQuery(label: string, q: any) {
  logger.info({ label, sql: q.toText?.() })
}
```

## Structured Fields for Observability

- service: name of service
- env: environment (prod/stage/dev)
- sql: raw SQL text (if enabled)
- table: primary table
- operation: select|insert|update|delete
- elapsedMs: timing measurement
- rows: rows returned/affected
- userId/requestId/correlationId: tracing

## Snapshot Testing Strategy

```ts
import { describe, expect, it } from 'bun:test'
import { config } from 'bun-query-builder'

describe('queries', () => {
  it('orders feed SQL', () => {
    config.debug = { captureText: true }
    const q: any = db
      .selectFrom('orders')
      .where(['status', '=', 'paid'])
      .orderBy('created_at', 'desc')
      .limit(10)
      .toSQL()
    expect(q.toText()).toContain('ORDER BY')
  })
})
```

## EXPLAIN vs EXPLAIN ANALYZE

- EXPLAIN: shows plan without executing
- EXPLAIN ANALYZE: executes and shows timings; use carefully in prod

```ts
const plan = await db.selectFrom('users').explain()
// For ANALYZE: use raw for now until helper is added
await db.unsafe('EXPLAIN ANALYZE SELECT * FROM users WHERE active = true')
```

## Timing Queries

```ts
function time<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now()
  return fn().finally(() => {
    const ms = Date.now() - start
    console.log(`[timing] ${label}: ${ms}ms`)
  })
}

await time('users.list', async () => {
  await db.selectFrom('users').limit(50).execute()
})
```

## Sampling Query Logs

```ts
const SAMPLE_RATE = 0.1
function shouldSample() {
  return Math.random() < SAMPLE_RATE
}

config.debug = { captureText: true }
const q: any = db.selectFrom('users').limit(10).toSQL()
if (shouldSample())
  console.log(q.toText())
```

## Conditional Logging with when()

```ts
await db
  .selectFrom('users')
  .when(process.env.DEBUG_SQL === '1', qb => qb.dump())
  .execute()
```

## Troubleshooting

- toText undefined: ensure `config.debug.captureText = true`
- Empty SQL output: ensure you called `.toSQL()` on a finalized builder
- Slow explain: EXPLAIN ANALYZE executes the query; use cautiously
- Missing parameters: prefer structured helpers instead of interpolated raw strings

## Extended FAQ

### Does enabling captureText affect performance?

Slightly, due to capturing and stringifying query text. Keep disabled in prod unless needed.

### Can I redact parameters automatically?

Yes, wrap logging and run a redaction function like `mask` above before persisting logs.

### How do I correlate logs with requests?

Add `correlationId`/`requestId` from your web framework context to each log entry.

### Can I get bound parameter values?

Prefer `values()` for a matrix of result values. Parameter arrays are not exposed uniformly; use raw cautiously if needed.

## Recipes

### Capture last executed SQL for assertions

```ts
let last: string | undefined
config.debug = { captureText: true }

async function run(qb: any) {
  const q = qb.toSQL()
  last = q.toText?.()
  return await q.execute()
}

await run(db.selectFrom('users').limit(1))
expect(last).toContain('LIMIT 1')
```

### Build a tiny logger plugin

```ts
export function withSqlLogging<DB>(qb: any, log: (s: string) => void) {
  return new Proxy(qb, {
    get(target, prop, receiver) {
      const val = Reflect.get(target, prop, receiver)
      if (typeof val === 'function') {
        return (...args: any[]) => {
          const out = val.apply(target, args)
          try {
            const q = out?.toSQL?.()
            const text = q?.toText?.()
            if (text)
              log(text)
          }
          catch {}
          return out
        }
      }
      return val
    },
  })
}
```

### Pretty print with colors

```ts
import kleur from 'kleur'
function pretty(sql: string) {
  return kleur.gray(sql.replace(/\s+/g, ' ').trim())
}
```

### Profiling heavy queries

Collect timings and sort by elapsed.

```ts
const timings: { label: string, ms: number }[] = []
async function timed<T>(label: string, f: () => Promise<T>) {
  const t0 = performance.now()
  const res = await f()
  const t1 = performance.now()
  timings.push({ label, ms: t1 - t0 })
  return res
}
```

### Reducing noise

- Log only SELECTs over a threshold
- Sample low-importance endpoints

### Security Considerations

- Avoid logging PII in raw SQL
- Ensure logs are access-controlled and retention-limited

### Observability Integration

Attach SQL text as a span attribute only when sampling.

```ts
import { context, trace } from '@opentelemetry/api'
const span = trace.getTracer('qb').startSpan('db.query')
span.setAttribute('db.system', 'postgres')
// span.setAttribute('db.statement', q.toText?.()) // consider sampling
span.end()
```

---

## Checklist

- [ ] Enable captureText in dev and tests only
- [ ] Use `dump` and `explain` during tuning
- [ ] Mask sensitive parameters in logs
- [ ] Attach correlation ids for tracing
- [ ] Keep logs structured and searchable
