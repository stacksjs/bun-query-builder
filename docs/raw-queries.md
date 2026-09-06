---
title: Raw Queries
description: Execute raw SQL queries when you need full control.
---

# Raw Queries

Execute raw SQL queries when you need full control over the query structure.

## Raw Select

Execute a raw SELECT query:

```typescript
import { createQueryBuilder } from 'bun-query-builder'

const db = createQueryBuilder<typeof schema>({ schema, meta })

// Raw query with parameters
const users = await db.raw(
  'SELECT * FROM users WHERE active = ? AND age > ?',
  [true, 18]
)

// Using named parameters
const posts = await db.raw(
  'SELECT * FROM posts WHERE user_id = $userId AND published = $published',
  { userId: 1, published: true }
)
```

## Raw Expressions in Queries

Use raw expressions within the query builder:

```typescript
// Raw in select
const results = await db
  .selectFrom('users')
  .selectRaw('COUNT(*) AS total, AVG(age) AS avg_age')
  .get()

// Raw in where
const recentUsers = await db
  .selectFrom('users')
  .whereRaw('DATE(created_at) > DATE_SUB(NOW(), INTERVAL 30 DAY)')
  .get()

// Raw in order by
const sorted = await db
  .selectFrom('products')
  .orderByRaw('price * quantity DESC')
  .get()

// Raw in group by
const grouped = await db
  .selectFrom('orders')
  .select(['SUM(amount) AS total'])
  .groupByRaw("strftime('%Y-%m', created_at)")
  .get()

// Raw in having
const filtered = await db
  .selectFrom('orders')
  .select(['user_id', 'SUM(amount) AS total'])
  .groupBy('user_id')
  .havingRaw('SUM(amount) > 1000')
  .get()

```

## Unsafe Queries

For queries that cannot use parameterized values:

```typescript

// Use with caution - values are not escaped
const result = await db.unsafe(`
  SELECT * FROM users
  WHERE email LIKE '%@example.com'
  ORDER BY created_at DESC
  LIMIT 10
`)

```

::: warning
Always prefer parameterized queries when possible to prevent SQL injection. Only use `unsafe` when absolutely necessary and never with user-provided input.
:::

## Execute Raw SQL

Execute non-query SQL statements:

```typescript

// Create an index
await db.unsafe('CREATE INDEX idx_users_email ON users(email)')

// Update statistics
await db.unsafe('ANALYZE users')

// Truncate table
await db.unsafe('TRUNCATE TABLE logs')

```

## Raw Fragments in the Builder (`raw`)

For raw fragments inside builder methods — `selectRaw`, `whereRaw`,
`orderByRaw`, `groupByRaw`, `havingRaw`, and `select()` — use the exported
`raw` helper:

```typescript
import { raw } from 'bun-query-builder'

await db.selectFrom('users').selectRaw(raw`count(*) as c`).get()
await db.selectFrom('users').whereRaw(raw('age > 18')).get()
await db.selectFrom('users').orderByRaw(raw`created_at desc`).get()

// Interpolated values are SQL-escaped:
await db.selectFrom('orders').whereRaw(raw`status = ${userStatus}`).get()
```

> **Do not pass a Bun `sql\`...\`` query to the `*Raw` methods.** A Bun query
> object cannot be converted back to SQL text (it stringifies to
> `"[object Promise]"`), so it would corrupt the generated SQL. The builder
> now throws a clear error if you do. `raw` returns a `{ raw }` fragment that
> renders correctly and satisfies the `SqlFragment` type (so it still passes
> the bare-string injection guard). For user input that must be
> parameterised, prefer the typed `where(...)` methods over `raw`.

## Raw with Bun Tagged Templates

For a fully raw statement (not composed with the builder), use the
connection's tagged template directly:

```typescript

const userId = 1
const status = 'active'

// Tagged template syntax — executes as its own statement
const users = await db.sql`
  SELECT * FROM users
  WHERE id = ${userId}
  AND status = ${status}
`

```

## File-Based Queries

Execute SQL from files:

```typescript

// Execute a SQL file
await db.file('./migrations/setup.sql')

// Execute with parameters
await db.file('./queries/get-user.sql', { userId: 1 })

```

## Raw with Type Inference

Get typed results from raw queries:

```typescript

interface UserStats {
  country: string
  count: number
  avg_age: number
}

const stats = await db.raw<UserStats[]>(`
  SELECT
    country,
    COUNT(*) AS count,
    AVG(age) AS avg_age
  FROM users
  GROUP BY country
  ORDER BY count DESC
`)

// stats is typed as UserStats[]
stats.forEach((s) => {
  console.log(`${s.country}: ${s.count} users, avg age ${s.avg_age}`)
})

```

## Prepared Statements

Use prepared statements for repeated queries:

```typescript

// Prepare a statement
const stmt = db.unsafe('SELECT * FROM users WHERE id = ?')

// Execute multiple times efficiently
const user1 = await stmt.get([1])
const user2 = await stmt.get([2])
const user3 = await stmt.get([3])

// Finalize when done
stmt.finalize()

```

## Transaction with Raw Queries

Execute raw queries within transactions:

```typescript

await db.transaction(async (trx) => {
  // Raw insert
  await trx.raw(
    'INSERT INTO audit_log (action, user_id) VALUES (?, ?)',
    ['login', userId]
  )

  // Regular query builder
  await trx.updateTable('users').set({ last_login: new Date() }).where({ id: userId })

  // Raw update
  await trx.raw(
    'UPDATE statistics SET login_count = login_count + 1 WHERE user_id = ?',
    [userId]
  )
})

```

## Explain Queries

Analyze query execution plans:

```typescript

// Get query execution plan — `explain()` terminates a builder chain
const explain = await db.selectFrom('users').where({ active: true }).explain()
console.log(explain)

// Using CLI
// query-builder explain "SELECT * FROM users WHERE active = true"

```

## Complete Example

```typescript

import { createQueryBuilder, buildDatabaseSchema, buildSchemaMeta } from 'bun-query-builder'

const models = {
  User: {
    name: 'User',
    table: 'users',
    primaryKey: 'id',
    attributes: {
      id: { validation: { rule: {} } },
      name: { validation: { rule: {} } },
      email: { validation: { rule: {} } },
      age: { validation: { rule: {} } },
      country: { validation: { rule: {} } },
      created_at: { validation: { rule: {} } },
    },
  },
}

const schema = buildDatabaseSchema(models)
const meta = buildSchemaMeta(models)
const db = createQueryBuilder<typeof schema>({ schema, meta })

// Complex analytics with raw queries
async function getComplexAnalytics() {
  // Complex aggregation not easily expressible with query builder
  interface MonthlyStats {
    month: string
    new_users: number
    returning_users: number
    total_active: number
  }

  const stats = await db.raw<MonthlyStats[]>(`
    WITH monthly_users AS (
      SELECT
        strftime('%Y-%m', created_at) AS month,
        id,
        COUNT(*) OVER (PARTITION BY id) AS visit_count
      FROM users
      WHERE created_at >= date('now', '-12 months')
    )
    SELECT
      month,
      SUM(CASE WHEN visit_count = 1 THEN 1 ELSE 0 END) AS new_users,
      SUM(CASE WHEN visit_count > 1 THEN 1 ELSE 0 END) AS returning_users,
      COUNT(*) AS total_active
    FROM monthly_users
    GROUP BY month
    ORDER BY month
  `)

  // Combine with query builder
  const basicStats = await db
    .selectFrom('users')
    .selectRaw(`
      COUNT(*) AS total,
      COUNT(CASE WHEN active = 1 THEN 1 END) AS active,
      AVG(age) AS avg_age
    `)
    .first()

  // Parameterized complex query
  const countryStats = await db.raw(
    `
    SELECT
      country,
      COUNT(*) AS user_count,
      AVG(age) AS avg_age
    FROM users
    WHERE active = ?
    GROUP BY country
    HAVING COUNT(*) > ?
    ORDER BY user_count DESC
    LIMIT ?
  `,
    [true, 10, 5]
  )

  return { stats, basicStats, countryStats }
}

getComplexAnalytics().then(console.log)

```

## CLI Commands

Execute queries from the command line:

```bash

# Execute a raw query

query-builder unsafe "SELECT * FROM users LIMIT 5"

# Execute with parameters

query-builder unsafe "SELECT * FROM users WHERE id = $1" --params "[1]"

# Execute a SQL file

query-builder file ./migrations/seed.sql

# Explain a query

query-builder explain "SELECT * FROM users WHERE active = true"

```

## Deferred SQLite INSERTs

For independent append-only records, SQLite builders expose `deferInsert` and
`flushDeferredInserts`. These optional methods are absent on other drivers.
Like `unsafe()`, they are raw operations and bypass query-builder hooks,
timestamps, validation, and model behavior.

```ts
const db = createQueryBuilder()
if (db.deferInsert) {
  await Promise.all([
    db.deferInsert('events', { message: 'first' }),
    db.deferInsert('events', { message: 'second' }),
  ])
}
```

`deferInsert` captures the table, ordered columns, and bound values immediately.
Table and column names are quoted as literal identifiers; values must be SQLite
bindings, not SQL expressions. Missing columns retain their database defaults;
explicit `undefined` binds `NULL`. Mutable binary bindings are copied.

Outside a transaction, contiguous records with identical column shapes can share
an INSERT and native transaction on the next event-loop turn. The queue retains
at most 32 rows or approximately 256 KiB of payload and metadata. Reaching either
limit drains existing work synchronously; an oversized record executes immediately.
Each promise settles after persistence or failure. A failed batch is rolled back
before individual retries, isolating rejected records without duplicating a
successful prefix. Trigger side effects in a failed retry are rolled back too.
Triggers with non-database side effects are not suitable for retryable inserts.
If native rollback fails, the connection is invalidated and closed; remaining
and future work rejects instead of entering an uncertain transaction.

Inside a raw or managed application transaction, inserts execute immediately and
their promises do not wait for commit. Ordinary transaction and INSERT semantics
apply, including rollback by the caller. Transaction controls, schema changes,
PRAGMAs, connection replacement, and close flush previously queued records first.
Configuration replacement preserves captured old builders; pending work stays on
its original connection. Reset and close reject subsequent deferred writes.

Ordinary SELECT/INSERT/UPDATE/DELETE statements do not implicitly flush the queue.
Await the insert promise, or call `db.flushDeferredInserts?.()` synchronously,
before reading or modifying data that depends on it. Deferred insertion is not a
replacement for an ordered sequence of ordinary writes. SQLite durability and
checkpoint settings are unchanged.
