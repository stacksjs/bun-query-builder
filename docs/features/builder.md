# Query Builder

Build type-safe SQL with a fluent API backed by Bun’s tagged template literals. All table/column types are inferred from your model files.

## Basics

```ts
const rows = await db
  .selectFrom('users')
  .where({ active: true })
  .orderBy('created_at', 'desc')
  .limit(10)
  .execute()
```

- `where({})` for equality; tuple `[col, op, val]` for explicit operators
- `orderBy`, `orderByDesc`, `latest`, `oldest`, `inRandomOrder`
- `groupBy`, `having`
- `union`, `unionAll`

## Joins

```ts
await db
  .selectFrom('users')
  .leftJoin('projects', 'users.id', '=', 'projects.user_id')
  .where(['projects.status', '=', 'active'])
  .execute()
```

Also `join`, `innerJoin`, `rightJoin`, `crossJoin`, `joinSub`, `leftJoinSub`, `crossJoinSub`.

## Raw helpers

- `whereRaw`, `groupByRaw`, `havingRaw`, `selectRaw`
- `whereColumn` and `orWhereColumn`
- `whereNested` and `orWhereNested`

## Best Practices

- Prefer composable helpers over raw strings where possible
- Use `selectAllRelations()` with `with()` to alias related columns safely
- For large result sets, prefer `paginate/simplePaginate/cursorPaginate`

## API Surface

- Selection
  - `selectFrom(table)` → start a SELECT `*`
  - `select(table, ...columns)` → select specific columns; supports `"expr as alias"`
- Filtering
  - `where(object)` equality map; `where([col, op, value])`; `andWhere`, `orWhere`
  - `whereNull`, `whereNotNull`, `whereBetween`, `whereNotBetween`, `whereDate`, `whereRaw`
  - `whereColumn`, `orWhereColumn`, `whereNested`, `orWhereNested`
- Ordering & limits
  - `orderBy`, `orderByDesc`, `latest(column?)`, `oldest(column?)`, `inRandomOrder()`, `reorder()`
  - `limit`, `offset`, `forPage(page, perPage)`
- Joins
  - `join`, `innerJoin`, `leftJoin`, `rightJoin`, `crossJoin`
  - Subquery joins: `joinSub`, `leftJoinSub`, `crossJoinSub`
- Grouping & unions
  - `groupBy`, `groupByRaw`, `having`, `havingRaw`
  - `union`, `unionAll`
- Modifiers
  - `distinct`, `distinctOn(...columns)` (Postgres)
- Execution
  - `toSQL()` → Bun query object; `execute()`, `values()`, `raw()`, `cancel()`
  - `simple()` → run using Postgres “simple” protocol (multi-statement, no parameters)
  - Optional `(q as any).toText?.()` if `config.debug.captureText = true`

## Insert / Update / Delete

- `insertInto(table).values(object|object[])`
- `updateTable(table).set(object).where(...)`
- `deleteFrom(table).where(...)`
- All support `returning(...columns)` on PG

## Examples

```ts
// select subset
await db.select('users', 'id', 'email').where({ active: true }).execute()

// nested conditions
await db
  .selectFrom('users')
  .whereNested(
    db.selectFrom('users').where(['age', '>=', 18]),
  )
  .execute()
```
