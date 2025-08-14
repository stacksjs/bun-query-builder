# Debugging

Techniques for inspecting queries, printing SQL, and understanding performance characteristics.

## Table of Contents

- Overview
- Enabling toText
- Dump, DD, and Explain
- Logging Queries
- Snapshot Testing
- Common Pitfalls
- Best Practices

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
await db.selectFrom('users').dump().execute() // prints SQL
await db.selectFrom('users').dd() // prints SQL then throws
await db.selectFrom('users').explain() // returns EXPLAIN rows
```

Use `explain` to understand query plans and add appropriate indexes.

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

config.hooks = {
  onQueryStart: ({ sql, kind }) => logger.debug({ kind, sql }),
  onQueryEnd: ({ sql, durationMs, rowCount }) => logger.info({ sql, durationMs, rowCount }),
  onQueryError: ({ sql, error }) => logger.error({ sql, error }),
  startSpan: ({ sql }) => {
    const span = tracer.startSpan('db.query')
    span.setAttribute('db.statement', sql)
    return { end: (err?: any) => { if (err) span.recordException(err); span.end() } }
  },
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

- Keep `captureText` disabled in production
- Prefer `toText` only for debugging/snapshots
- Use `explain` for performance tuning

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
function shouldSample() { return Math.random() < SAMPLE_RATE }

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
