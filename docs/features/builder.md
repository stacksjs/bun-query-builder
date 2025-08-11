# Query Builder

Build type-safe SQL with a fluent API backed by Bun’s tagged template literals. All table/column types are inferred from your model files.

This page covers concepts, API, recipes, performance tips, and common pitfalls when using the builder.

## Table of Contents

- Overview
- Getting Started
- Selecting Data
- Filtering and Condition Building
- Joining Tables (including Subquery Joins)
- Grouping, Aggregates, and Having
- Ordering, Limiting, Paging
- Modifiers: Distinct and Distinct On
- Raw Expressions and When to Use Them
- Relations Shortcuts and Auto-Aliasing
- Common DML (Insert/Update/Delete) with Returning
- Pagination and Chunking
- CTEs and Recursive Queries
- Locks and Concurrency Controls
- Flow Utilities: when, tap, dump, dd, explain
- Execution, toSQL, simple, values, raw
- Debugging and toText
- Security and SQL Injection Safety
- Type-safety Guide
- Performance Tips
- Error Handling
- Recipes
- FAQ

## Overview

The query builder emits Bun `sql` queries. `toSQL()` returns a Bun query object with methods: `execute()`, `values()`, `raw()`, `cancel()`. This preserves Bun’s performance and safety while providing a Laravel/Kysely-like fluent API.

- Fully typed via your model definitions
- Composable, chainable methods
- Ergonomic helpers for dates, JSON, NULL checks, column-to-column comparisons

## Getting Started

```ts
const rows = await db
  .selectFrom('users')
  .where({ active: true })
  .orderBy('created_at', 'desc')
  .limit(10)
  .execute()
```

Notes:

- `where({})` builds equality comparisons for provided keys
- tuple form `[column, operator, value]` gives explicit control
- Use `orderByDesc`, `latest`, `oldest`, and `reorder` as needed

## Selecting Data

```ts
// select all columns
await db.selectFrom('projects').limit(5).execute()

// select subset with aliases
await db.select('users', 'id', 'email', 'name as display_name').execute()

// select with raw fragments
await db
  .selectFrom('users')
  .selectRaw(db.sql`COUNT(*) as total`)
  .groupBy('status')
  .execute()
```

### Aliases and Expressions

- Use `"expr as alias"` in `select(table, ...)`
- Or use `selectRaw` for complex expressions

## Filtering and Condition Building

Supported operators: `=`, `!=`, `<`, `>`, `<=`, `>=`, `like`, `in`, `not in`, `is`, `is not`.

```ts
await db.selectFrom('users').where(['age', '>=', 18]).execute()
await db.selectFrom('users').where({ active: true, country: 'US' }).execute()
```

### NULL and BETWEEN helpers

```ts
await db.selectFrom('orders').whereNull('shipped_at').execute()
await db.selectFrom('orders').whereBetween('total', 100, 500).execute()
await db.selectFrom('orders').whereNotBetween('total', 100, 500).execute()
```

### Column to Column and Nesting

```ts
await db
  .selectFrom('events')
  .whereColumn('start_at', '<=', 'end_at')
  .orWhereNested(
    db.selectFrom('events').where(['name', 'like', '%conf%']),
  )
  .execute()
```

### Dates and JSON

```ts
await db.selectFrom('events').whereDate('start_at', '>=', new Date()).execute()
await db.selectFrom('users').whereJsonContains('meta', { beta: true }).execute()
```

## Joining Tables

```ts
await db
  .selectFrom('users')
  .innerJoin('profiles', 'users.id', '=', 'profiles.user_id')
  .leftJoin('projects', 'users.id', '=', 'projects.user_id')
  .where(['projects.status', '=', 'active'])
  .execute()
```

### Subquery Joins

```ts
const activeProjects = db
  .selectFrom('projects')
  .where(['status', '=', 'active'])

await db
  .selectFrom('users')
  .joinSub(activeProjects, 'ap', 'users.id', '=', 'ap.user_id')
  .execute()
```

## Grouping, Aggregates, Having

```ts
await db
  .selectFrom('users')
  .groupBy('country')
  .having(['country', '!=', ''])
  .execute()
```

Aggregate helpers are available on the root builder:

```ts
await db.count('users')
await db.sum('orders', 'total')
await db.avg('orders', 'total')
await db.min('orders', 'total')
await db.max('orders', 'total')
```

## Ordering, Limiting, Paging

```ts
await db
  .selectFrom('articles')
  .latest('published_at')
  .forPage(2, 25)
  .execute()
```

### Random ordering

```ts
await db.selectFrom('tips').inRandomOrder().limit(1).execute()
```

## Modifiers: Distinct and Distinct On

```ts
await db.selectFrom('users').distinct().execute()
await db.selectFrom('users').distinctOn('email').execute() // PG-only
```

## Raw Expressions

Use raw sparingly for complex cases not covered by helpers.

```ts
await db
  .selectFrom('users')
  .whereRaw(db.sql`coalesce(age, 0) > 0`)
  .groupByRaw(db.sql`country`)
  .havingRaw(db.sql`count(*) > 10`)
  .execute()
```

## Relations Shortcuts and Auto-Aliasing

```ts
await db
  .selectFrom('users')
  .with('Project')
  .selectAllRelations()
  .execute()
```

Configure alias formats via `config.aliasing.relationColumnAliasFormat`.

## DML: Insert / Update / Delete

```ts
// insert single
await db.insertInto('users').values({ name: 'Alice' }).execute()

// insert multiple
await db.insertInto('users').values([
  { name: 'A' },
  { name: 'B' },
]).execute()

// returning (PG)
await db.insertInto('users').values({ name: 'C' }).returning('id').execute()

// update
await db.updateTable('users').set({ active: false }).where(['id', '=', 1]).execute()

// delete
await db.deleteFrom('users').where(['id', 'in', [2, 3]]).execute()
```

## Pagination and Chunking

See the Pagination page for details. Highlights:

```ts
await db.selectFrom('users').paginate(25, 1)
await db.selectFrom('users').simplePaginate(25)
await db.selectFrom('users').cursorPaginate(100, undefined, 'id', 'asc')
await db.selectFrom('users').chunkById(1000, 'id', async batch => { /* ... */ })
```

## CTEs and Recursive Queries

```ts
const sub = db.selectFrom('users').where(['active', '=', true])
await db.selectFrom('users').withCTE('active_users', sub).execute()

const recursive = db.selectFrom('nodes') // build your recursive part
await db.selectFrom('nodes').withRecursive('tree', recursive).execute()
```

## Locks and Concurrency Controls

```ts
await db.selectFrom('orders').lockForUpdate().execute()
await db.selectFrom('orders').sharedLock().execute()
```

Respect your dialect via `config.sql.sharedLockSyntax`.

## Flow Utilities

```ts
await db
  .selectFrom('users')
  .when(process.env.DEBUG, qb => qb.dump())
  .tap(qb => qb.orderBy('created_at', 'desc'))
  .explain()
```

- `when(cond, then, otherwise?)`
- `tap(fn)` for inline mutation
- `dump()` prints SQL
- `dd()` prints then throws
- `explain()` returns plan rows

## Execution, toSQL, simple, values, raw

```ts
const q = db.selectFrom('users').where({ active: true }).toSQL()
const rows = await q.execute()
const valueMatrix = await q.values()
const rawWire = await q.raw()

// simple protocol (e.g., DDL or multi-statement)
await (q as any).simple()?.execute?.()
```

## Debugging and toText

```ts
import { config } from 'bun-query-builder'
config.debug = { captureText: true }
const q = db.selectFrom('users').where({ active: true }).toSQL()
console.log((q as any).toText?.())
```

Disable in production.

## Security and SQL Injection Safety

- Most methods parameterize inputs under the hood via Bun `sql`
- Prefer structured helpers over raw strings
- Validate dynamic identifiers if interpolated into raw fragments

## Type-safety Guide

- Tables and columns are typed from your model definitions
- `select('table', 'col as alias')` maintains output typing for known columns
- Joining introduces union of tables for column refs via `JoinColumn` typing

## Performance Tips

- Use `select()` to avoid fetching unnecessary columns
- Prefer `paginate` or `cursorPaginate` over large offsets
- Push heavy work into the database with aggregates and CTEs when appropriate

## Error Handling

- Wrap calls in transactions for multi-step consistency
- Consider `when` to toggle debug/trace behavior

## Recipes

### Soft deletes

```ts
await db.updateTable('users').set({ deleted_at: new Date() }).where(['id', '=', 1]).execute()
await db.selectFrom('users').whereNull('deleted_at').execute()
```

### Upserts

```ts
await db.upsert('users', [{ email: 'a@b.com', name: 'A' }], ['email'], ['name'])
```

### Federated search (union)

```ts
const byTitle = db.selectFrom('articles').where(['title', 'like', '%bun%'])
const byBody = db.selectFrom('articles').where(['body', 'like', '%bun%'])
await byTitle.unionAll(byBody).execute()
```

### With counts

```ts
await db
  .selectFrom('users')
  .withCount('Project', 'projects_count', ['status', '=', 'active'])
  .execute()
```

## FAQ

### Why does `toSQL()` return an object instead of a string?

Because Bun’s `sql` returns a query object that preserves parameterization and execution features. We expose it directly for performance and safety.

### How do I print the SQL text?

Enable `config.debug.captureText = true` and call `(q as any).toText?.()`.

### How do I compare two columns?

Use `whereColumn(left, op, right)`.

### How do I add arbitrary fragments?

Use `selectRaw`, `whereRaw`, `groupByRaw`, or `havingRaw` and pass a Bun `sql` fragment.

---

## Quick Reference

- Selection: `selectFrom`, `select`, `selectRaw`
- Filters: `where`, `andWhere`, `orWhere`, `whereNull`, `whereBetween`, `whereColumn`, `whereDate`, `whereJsonContains`, `whereNested`
- Joins: `join`, `innerJoin`, `leftJoin`, `rightJoin`, `crossJoin`, `joinSub`, `leftJoinSub`, `crossJoinSub`
- Grouping: `groupBy`, `groupByRaw`, `having`, `havingRaw`
- Unions: `union`, `unionAll`
- Modifiers: `distinct`, `distinctOn`
- Order/Paging: `orderBy`, `orderByDesc`, `latest`, `oldest`, `inRandomOrder`, `reorder`, `limit`, `offset`, `forPage`
- Results: `value`, `pluck`, `exists`, `doesntExist`
- Pagination: `paginate`, `simplePaginate`, `cursorPaginate`, `chunk`, `chunkById`, `eachById`
- DML: `insertInto`, `updateTable`, `deleteFrom`, `returning`
- Flow: `when`, `tap`, `dump`, `dd`, `explain`
- CTEs: `withCTE`, `withRecursive`
- Locks: `lockForUpdate`, `sharedLock`
