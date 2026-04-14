---
title: Raw Queries
description: Execute raw SQL queries when you need full control.
---
  .get()

// Raw in group by
const grouped = await db
  .selectFrom('orders')
  .select(['SUM(amount) AS total'])
  .groupByRaw("strftime('%Y-%m', created*at)")
  .get()

// Raw in having
const filtered = await db
  .selectFrom('orders')
  .select(['user*id', 'SUM(amount) AS total'])
  .groupBy('user*id')
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
  ORDER BY created*at DESC
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
await db.execute('CREATE INDEX idx*users*email ON users(email)')

// Update statistics
await db.execute('ANALYZE users')

// Truncate table
await db.execute('TRUNCATE TABLE logs')

```

## Raw with Bun Tagged Templates

Leverage Bun's tagged template literal for safe queries:

```typescript

const userId = 1
const status = 'active'

// Tagged template syntax (if supported)
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
  avg*age: number
}

const stats = await db.raw<UserStats[]>(`
  SELECT
    country,
    COUNT(*) AS count,
    AVG(age) AS avg*age
  FROM users
  GROUP BY country
  ORDER BY count DESC
`)

// stats is typed as UserStats[]
stats.forEach((s) => {
  console.log(`${s.country}: ${s.count} users, avg age ${s.avg*age}`)
})

```

## Prepared Statements

Use prepared statements for repeated queries:

```typescript

// Prepare a statement
const stmt = db.prepare('SELECT * FROM users WHERE id = ?')

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
    'INSERT INTO audit*log (action, user*id) VALUES (?, ?)',
    ['login', userId]
  )

  // Regular query builder
  await trx.update('users', userId, { last*login: new Date() })

  // Raw update
  await trx.raw(
    'UPDATE statistics SET login*count = login*count + 1 WHERE user*id = ?',
    [userId]
  )
})

```

## Explain Queries

Analyze query execution plans:

```typescript

// Get query execution plan
const explain = await db.explain('SELECT * FROM users WHERE active = true')
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
      created*at: { validation: { rule: {} } },
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
    new*users: number
    returning*users: number
    total*active: number
  }

  const stats = await db.raw<MonthlyStats[]>(`
    WITH monthly*users AS (
      SELECT
        strftime('%Y-%m', created*at) AS month,
        id,
        COUNT(*) OVER (PARTITION BY id) AS visit*count
      FROM users
      WHERE created*at >= date('now', '-12 months')
    )
    SELECT
      month,
      SUM(CASE WHEN visit*count = 1 THEN 1 ELSE 0 END) AS new*users,
      SUM(CASE WHEN visit*count > 1 THEN 1 ELSE 0 END) AS returning*users,
      COUNT(*) AS total*active
    FROM monthly*users
    GROUP BY month
    ORDER BY month
  `)

  // Combine with query builder
  const basicStats = await db
    .selectFrom('users')
    .selectRaw(`
      COUNT(*) AS total,
      COUNT(CASE WHEN active = 1 THEN 1 END) AS active,
      AVG(age) AS avg*age
    `)
    .first()

  // Parameterized complex query
  const countryStats = await db.raw(
    `
    SELECT
      country,
      COUNT(*) AS user*count,
      AVG(age) AS avg*age
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
